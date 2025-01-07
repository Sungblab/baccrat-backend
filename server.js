const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const http = require("http");
const socketIo = require("socket.io");
require("dotenv").config();

// 환경 변수 설정
const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret"; // 반드시 환경 변수로 관리하세요
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/betting_game";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://127.0.0.1:5500";

// Express 애플리케이션과 HTTP 서버 설정
const app = express();
const server = http.createServer(app);

// CORS 옵션 설정
const corsOptions = {
  origin: FRONTEND_URL,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

// 미들웨어 설정
app.use(cors(corsOptions));
app.use(express.json());

// Socket.IO 설정
const io = socketIo(server, {
  cors: corsOptions,
});

// MongoDB 연결
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB 연결됨"))
  .catch((err) => console.error("MongoDB 연결 에러:", err));

// 사용자 스키마 및 모델 정의
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  coins: {
    type: Number,
    default: 2, // 기본 코인 수를 2로 설정
  },
  role: {
    type: String,
    enum: ["user", "admin"],
    default: "user",
  },
  isApproved: {
    type: Boolean,
    default: false,
  },
  bettingHistory: [
    {
      choice: { type: String, enum: ["player", "banker", "tie"] },
      coins: Number,
      result: { type: String, enum: ["win", "lose", "draw"] },
      gameResult: { type: String, enum: ["player", "banker", "tie"] },
      date: { type: Date, default: Date.now },
    },
  ],
  usedBetsForExchange: {
    type: Number,
    default: 0,
  },
});

const User = mongoose.model("User", userSchema);

// 인증 미들웨어
const auth = (roles = []) => {
  // roles는 문자열 또는 문자열 배열이어야 합니다.
  if (typeof roles === "string") {
    roles = [roles];
  }

  return (req, res, next) => {
    const authHeader = req.header("Authorization");
    if (!authHeader) {
      return res.status(401).json({ message: "인증 토큰이 필요합니다." });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "인증 토큰이 필요합니다." });
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;

      if (roles.length && !roles.includes(req.user.role)) {
        return res.status(403).json({ message: "권한이 없습니다." });
      }

      next();
    } catch (err) {
      return res.status(401).json({ message: "유효하지 않은 토큰입니다." });
    }
  };
};

// =====================
// 라우트 정의
// =====================

// 기본 라우트
app.get("/", (req, res) => {
  res.send("Betting Game Backend");
});

// ---------------------
// 인증 라우트
// ---------------------
app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body;

  try {
    let user = await User.findOne({ username });
    if (user) {
      return res.status(400).json({ message: "이미 존재하는 사용자입니다." });
    }

    user = new User({ username, password }); // 기본 코인 수는 스키마에서 설정

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    await user.save();

    res.json({ message: "회원가입이 완료되었습니다. 승인이 필요합니다." });
  } catch (err) {
    console.error("회원가입 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    let user = await User.findOne({ username });
    if (!user) {
      return res.status(400).json({ message: "사용자를 찾을 수 없습니다." });
    }

    if (!user.isApproved) {
      return res.status(403).json({ message: "관리자의 승인이 필요합니다." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "잘못된 비밀번호입니다." });
    }

    const payload = { id: user._id, role: user.role };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });

    res.json({ token });
  } catch (err) {
    console.error("로그인 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 사용자 정보 가져오기
app.get("/api/auth/user-info", auth(), async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    // 총 베팅액과 사용된 베팅액을 고려한 환전 가능 금액 계산
    const totalBets = user.bettingHistory.reduce(
      (sum, bet) => sum + bet.coins,
      0
    );
    const usedBets = user.usedBetsForExchange || 0;
    const availableRollingPoint = Math.max(0, Math.floor(totalBets) - usedBets);

    res.json({
      coins: user.coins,
      bettingHistory: user.bettingHistory,
      totalBets,
      usedBetsForExchange: usedBets,
      availableRollingPoint,
    });
  } catch (err) {
    console.error("사용자 정보 가져오기 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// ---------------------
// 관리자 라우트
// ---------------------
app.get("/api/admin/users", auth("admin"), async (req, res) => {
  try {
    const users = await User.find().select("-password");
    res.json(users);
  } catch (err) {
    console.error("사용자 조회 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 사용자 승패 통계 가져오기
app.get("/api/admin/users-stats", auth("admin"), async (req, res) => {
  try {
    const users = await User.find().select("-password");
    const stats = users.map((user) => {
      const wins = user.bettingHistory.filter(
        (bet) => bet.result === "win"
      ).length;
      const losses = user.bettingHistory.filter(
        (bet) => bet.result === "lose"
      ).length;
      const totalBets = user.bettingHistory.length;
      const winRate =
        totalBets === 0 ? 0 : ((wins / totalBets) * 100).toFixed(2);

      return {
        _id: user._id,
        username: user.username,
        coins: user.coins,
        role: user.role,
        isApproved: user.isApproved,
        wins,
        losses,
        totalBets,
        winRate,
      };
    });

    res.json(stats);
  } catch (err) {
    console.error("사용자 통계 조회 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 리더보드 API 수정
app.get("/api/admin/leaderboard", auth("admin"), async (req, res) => {
  try {
    const users = await User.find().select("username coins bettingHistory");

    const leaderboard = users.map((user) => {
      const stats = user.bettingHistory.reduce(
        (acc, bet) => {
          acc.totalBets++;
          acc.totalCoins += bet.coins;
          if (bet.result === "win") acc.wins++;
          return acc;
        },
        { totalBets: 0, totalCoins: 0, wins: 0 }
      );

      return {
        username: user.username,
        coins: user.coins,
        totalBets: stats.totalBets,
        winRate:
          stats.totalBets > 0
            ? ((stats.wins / stats.totalBets) * 100).toFixed(1)
            : 0,
        totalWagered: stats.totalCoins,
      };
    });

    // 코인 보유량으로 정렬
    leaderboard.sort((a, b) => b.coins - a.coins);

    res.json(leaderboard);
  } catch (err) {
    console.error("리더보드 조회 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 사용자 삭제
app.delete("/api/admin/users/:id", auth("admin"), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    // superadmin은 삭제 불가
    if (user.role === "superadmin") {
      return res
        .status(403)
        .json({ message: "최고 관리자는 삭제할 수 없습니다." });
    }

    await User.findByIdAndDelete(req.params.id);
    res.json({ message: "사용자가 삭제되었습니다." });
  } catch (err) {
    console.error("사용자 삭제 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 비밀번호 초기화
app.put(
  "/api/admin/users/:id/reset-password",
  auth("admin"),
  async (req, res) => {
    const { newPassword } = req.body;
    try {
      const user = await User.findById(req.params.id);
      if (!user)
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });

      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(newPassword, salt);

      await user.save();
      res.json({ message: "비밀번호가 초기화되었습니다." });
    } catch (err) {
      console.error("비밀번호 초기화 에러:", err);
      res.status(500).json({ message: "서버 에러" });
    }
  }
);

// 관리자 지정
app.put("/api/admin/users/:id/make-admin", auth("admin"), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user)
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });

    user.role = "admin";
    await user.save();

    res.json({ message: "관리자로 지정되었습니다." });
  } catch (err) {
    console.error("관리자 지정 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 사용자 승인하기
app.put("/api/admin/users/:id/approve", auth("admin"), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    user.isApproved = true;
    await user.save();

    res.json({
      message: "사용자가 승인되었습니다.",
      user: {
        _id: user._id,
        username: user.username,
        isApproved: user.isApproved,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("사용자 승인 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 코인 조절하기
app.put(
  "/api/admin/users/:id/adjust-coins",
  auth("admin"),
  async (req, res) => {
    const { adjustment } = req.body;
    try {
      const user = await User.findById(req.params.id);
      if (!user) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }

      user.coins += parseInt(adjustment);
      if (user.coins < 0) user.coins = 0;
      await user.save();

      res.json({
        message: `코인이 조정되었습니다. 현재 코인: ${user.coins}`,
        coins: user.coins,
      });
    } catch (err) {
      console.error("코인 조절 에러:", err);
      res.status(500).json({ message: "서버 에러" });
    }
  }
);

// 전체 베팅 기록 API 수정
app.get("/api/admin/all-betting-history", auth("admin"), async (req, res) => {
  try {
    // 최근 100개의 베팅 기록만 가 정
    const users = await User.find()
      .select("username bettingHistory")
      .sort({ "bettingHistory.date": -1 })
      .lean();

    // 모든 베팅 기록을 하나의 배열로 합치기
    let allBets = [];
    users.forEach((user) => {
      if (user.bettingHistory && user.bettingHistory.length > 0) {
        const userBets = user.bettingHistory.map((bet) => ({
          username: user.username,
          date: bet.date,
          choice: bet.choice,
          gameResult: bet.gameResult,
          coins: bet.coins,
          result: bet.result,
          profit: calculateProfit(bet),
        }));
        allBets = allBets.concat(userBets);
      }
    });

    // 날짜순 정렬 및 최근 100개만 반환
    allBets.sort((a, b) => new Date(b.date) - new Date(a.date));
    allBets = allBets.slice(0, 100);

    res.json(allBets);
  } catch (err) {
    console.error("전체 베팅 기록 조회 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 수익 계산 함수 수정
function calculateProfit(bet) {
  try {
    if (bet.result === "win") {
      if (bet.choice === "tie") {
        return bet.coins * 5;
      }
      return bet.coins * 2;
    } else if (bet.result === "draw") {
      return 0;
    }
    return -bet.coins;
  } catch (error) {
    console.error("수익 계산 에러:", error);
    return 0;
  }
}

// 게임 결과 저장 시 통계 정보 추가
app.post("/api/admin/set-result", auth("admin"), async (req, res) => {
  const { result } = req.body;
  if (!["player", "banker", "tie"].includes(result)) {
    return res.status(400).json({ message: "유효하지 않은 결과입니다." });
  }

  try {
    // 현재 베팅 통계 계산
    const stats = {
      player: { count: 0, total: 0, profit: 0 },
      banker: { count: 0, total: 0, profit: 0 },
      tie: { count: 0, total: 0, profit: 0 },
    };

    let totalBets = 0;
    let totalProfit = 0;
    const uniquePlayers = new Set();

    currentBets.forEach((bet) => {
      stats[bet.choice].count++;
      stats[bet.choice].total += bet.coins;
      totalBets += bet.coins;
      uniquePlayers.add(bet.userId);

      // 수익/손실 계산
      const profit = calculateProfit({
        choice: bet.choice,
        coins: bet.coins,
        result:
          bet.choice === result
            ? "win"
            : bet.choice === "tie"
            ? "draw"
            : "lose",
      });
      stats[bet.choice].profit += profit;
      totalProfit += profit;
    });

    // 게임 결과 저장
    const game = new Game({
      result,
      stats,
      totalBets,
      totalProfit,
      playerCount: uniquePlayers.size,
      date: new Date(),
    });
    await game.save();

    // 게임 결과를 모든 클라이언트에게 전송
    io.emit("game_result", {
      result,
      stats,
      totalBets,
      playerCount: uniquePlayers.size,
    });

    console.log(`게임 결과가 설정되었습니다: ${result}`);

    // 현재 베팅 내역을 처리
    for (const bet of currentBets) {
      try {
        const user = await User.findById(bet.userId);
        if (!user) continue;

        let outcome;
        if (result === "tie") {
          if (bet.choice === "tie") {
            user.coins += bet.coins * 5;
            outcome = "win";
          } else {
            user.coins += bet.coins;
            outcome = "draw";
          }
        } else {
          if (bet.choice === result) {
            user.coins += bet.coins * 2;
            outcome = "win";
          } else {
            outcome = "lose";
          }
        }

        user.bettingHistory.push({
          choice: bet.choice,
          coins: bet.coins,
          result: outcome,
          gameResult: result,
        });

        await user.save();
      } catch (err) {
        console.error("베팅 결과 처리 에러:", err);
      }
    }

    // 모든 사용자에게 코인 업데이트 알림
    io.emit("update_coins");

    // 베팅 내역 초기화
    currentBets = [];
    currentBettingStats = {
      player: { count: 0, total: 0 },
      banker: { count: 0, total: 0 },
      tie: { count: 0, total: 0 },
    };

    res.json({
      message: "게임 결과가 설정되고 사용자 코인이 업데이트되었습니다.",
    });
  } catch (err) {
    console.error("게임 결과 설정 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================
// Socket.io 설정 및 베팅 로직
// =====================
let currentBets = []; // 현재 베팅 내역 저장
let bettingActive = false; // 베팅 활성 상태
let bettingEndTime = null; // 베팅 종료 시간
let currentBettingStats = {
  player: { count: 0, total: 0 },
  banker: { count: 0, total: 0 },
  tie: { count: 0, total: 0 },
}; // 실시간 베팅 통계

// 현재 게임 결과를 저장할 변수 추가
let currentGameResult = null;

io.on("connection", (socket) => {
  console.log("새 클라이언트 접속:", socket.id);

  // 접속 시 현재 베팅 상태 전송
  socket.emit("betting_status", {
    active: bettingActive,
    endTime: bettingEndTime,
    stats: currentBettingStats,
  });

  // 게임 상태 관리
  let gameState = {
    isBetting: false,
    endTime: null,
  };

  // 베팅 시작 이벤트 (관리자에 의해 호출됨)
  socket.on("start_betting", () => {
    console.log("베팅 시작 요청 받음");
    const bettingDuration = 20; // 20초
    const endTime = new Date(Date.now() + bettingDuration * 1000);

    // 베팅 활성화
    bettingActive = true;
    bettingEndTime = endTime;

    // 모든 클라이언트에게 베팅 시작과 종료 시간 알림
    io.emit("betting_started");
    io.emit("betting_end_time", endTime);
    console.log("베팅 시작 알림 전송됨", { endTime });

    // 20초 후 베팅 종료
    setTimeout(() => {
      bettingActive = false;
      bettingEndTime = null;
      io.emit("betting_closed");
      console.log("베팅 종료 알림 전송됨");
    }, bettingDuration * 1000);
  });

  // 베팅 데이터 수신
  socket.on("place_bet", async (betData) => {
    const { choice, coins, token } = betData;
    console.log("베팅 요청 받음:", { choice, coins }); // 디버깅용 로그 추가

    if (!bettingActive) {
      console.log("베팅 비활성화 상태"); // 디버깅용 로그 추가
      return socket.emit("error", "현재 베팅이 진행 중이지 않습니다.");
    }

    if (!token) {
      return socket.emit("error", "인증 토큰이 필요합니다.");
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;
      const user = await User.findById(userId);

      if (!user) {
        return socket.emit("error", "사용자를 찾을 수 없습니다.");
      }

      // 이미 베팅했는지 확인
      const existingBet = currentBets.find((bet) => bet.userId === userId);
      if (existingBet) {
        return socket.emit("error", "이미 베팅하셨습니다.");
      }

      // 베팅 제한 확인
      if (!["player", "banker", "tie"].includes(choice)) {
        return socket.emit("error", "유효하지 않은 선택입니다.");
      }

      if (coins < 1 || coins > 5) {
        return socket.emit("error", "코인 개수는 1에서 5 사이여야 합니다.");
      }

      if (user.coins < coins) {
        return socket.emit("error", "코인이 부족합니다.");
      }

      // 베팅 시점에 코인 차감
      user.coins -= coins;
      await user.save();

      // 베팅 저장
      const bet = {
        userId,
        choice,
        coins,
        username: user.username,
      };
      currentBets.push(bet);

      // 베팅 통계 업데이트
      currentBettingStats[choice].count++;
      currentBettingStats[choice].total += coins;

      // 모든 클라이언트에게 새로운 베팅 정보 전송
      io.emit("new_bet", {
        choice,
        stats: currentBettingStats,
      });

      socket.emit("bet_success", "베팅이 완료되었습니다.");
      console.log(
        `사용자 ${user.username}이(가) 베팅: ${choice}, 코인: ${coins}`
      );
    } catch (err) {
      console.error("베팅 에러:", err);
      socket.emit("error", "베팅 처리 중 오류가 발생했습니다.");
    }
  });

  // 게임 결과 처리 이벤트 핸들러 수정
  socket.on("game_result", async (data) => {
    const { result, playerScore, bankerScore, timestamp } = data;

    // 현재 게임 결과 저장
    currentGameResult = {
      result,
      playerScore,
      bankerScore,
      timestamp,
      stats: currentBettingStats,
      totalBets: currentBets.reduce((sum, bet) => sum + bet.coins, 0),
      playerCount: new Set(currentBets.map((bet) => bet.userId)).size,
    };

    // 관리자에게 결과 전달
    io.emit("game_result", { result, playerScore, bankerScore, timestamp });
    console.log("게임 결과 수신:", { result, playerScore, bankerScore });
  });

  // 결과 승인 처리 수정
  socket.on("approve_result", async () => {
    try {
      if (!currentGameResult) {
        throw new Error("승인할 게임 결과가 없습니다.");
      }

      // 게임 결과 저장
      const game = new Game({
        result: currentGameResult.result,
        stats: currentGameResult.stats,
        totalBets: currentGameResult.totalBets,
        playerCount: currentGameResult.playerCount,
        date: new Date(currentGameResult.timestamp),
      });
      await game.save();

      // 최근 게임 결과 조회
      const recentGames = await Game.find()
        .select("result date stats totalBets playerCount")
        .sort({ date: -1 })
        .limit(36)
        .lean();

      // 모든 클라이언트에게 최신 게임 결과 전송
      io.emit("recent_games_updated", {
        recentGames,
        stats: {
          playerWins: recentGames.filter((g) => g.result === "player").length,
          bankerWins: recentGames.filter((g) => g.result === "banker").length,
          ties: recentGames.filter((g) => g.result === "tie").length,
          totalGames: recentGames.length,
        },
      });

      // 베팅 결과 처리
      for (const bet of currentBets) {
        try {
          const user = await User.findById(bet.userId);
          if (!user) continue;

          let outcome;
          if (currentGameResult.result === "tie") {
            if (bet.choice === "tie") {
              user.coins += bet.coins * 5; // 타이 배당 5배
              outcome = "win";
            } else {
              user.coins += bet.coins; // 본전 반환
              outcome = "draw";
            }
          } else {
            if (bet.choice === currentGameResult.result) {
              user.coins += bet.coins * 2; // 승리 배당 2배
              outcome = "win";
            } else {
              outcome = "lose";
            }
          }

          // 베팅 기록 추가
          user.bettingHistory.push({
            choice: bet.choice,
            coins: bet.coins,
            result: outcome,
            gameResult: currentGameResult.result,
            date: new Date(),
          });

          await user.save();
        } catch (err) {
          console.error("베팅 결과 처리 에러:", err);
        }
      }

      // 결과 전송
      io.emit("result_approved");
      io.emit("update_coins");

      // 상태 초기화
      currentBets = [];
      currentBettingStats = {
        player: { count: 0, total: 0 },
        banker: { count: 0, total: 0 },
        tie: { count: 0, total: 0 },
      };
      currentGameResult = null;

      console.log("게임 결과 승인 완료");
    } catch (err) {
      console.error("게임 결과 승인 처리 에러:", err);
      socket.emit("error", "게임 결과 승인 처리 중 오류가 발생했습니다.");
    }
  });

  // 결과 거절 처리
  socket.on("reject_result", () => {
    currentGameResult = null; // 현재 게임 결과 초기화
    io.emit("result_rejected");
    console.log("게임 결과 거절됨");
  });

  socket.on("disconnect", () => {
    console.log("클라이언트 연결 종료:", socket.id);
  });
});

// 게임 기록 스키마 및 모델 정의
const gameSchema = new mongoose.Schema({
  result: {
    type: String,
    enum: ["player", "banker", "tie"],
    required: true,
  },
  date: {
    type: Date,
    default: Date.now,
  },
  stats: {
    player: {
      count: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    banker: {
      count: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    tie: {
      count: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
  },
  totalBets: { type: Number, default: 0 },
  playerCount: { type: Number, default: 0 },
});

const Game = mongoose.model("Game", gameSchema);

// 최근 게임 결과 API 수정
app.get("/api/recent-games", async (req, res) => {
  try {
    const recentGames = await Game.find()
      .select("result date stats totalBets playerCount")
      .sort({ date: -1 })
      .limit(10)
      .lean();

    res.json(recentGames);
  } catch (err) {
    console.error("최근 게임 기록 조회 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 관리자용 최근 게임 기록 API 수정
app.get("/api/admin/recent-games", auth("admin"), async (req, res) => {
  const { limit = 100 } = req.query;

  try {
    const recentGames = await Game.find()
      .select("result date stats totalBets playerCount")
      .sort({ date: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json(recentGames);
  } catch (err) {
    console.error("최근 게임 기록 조회 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 관리자 토글 API 추가
app.put(
  "/api/admin/users/:id/toggle-admin",
  auth("admin"),
  async (req, res) => {
    try {
      const { setAdmin } = req.body;
      const user = await User.findById(req.params.id);

      if (!user) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }

      // superadmin은 정 불가
      if (user.role === "superadmin") {
        return res
          .status(403)
          .json({ message: "최고 관리자는 수정할 수 없습니다." });
      }

      user.role = setAdmin ? "admin" : "user";
      await user.save();

      res.json({
        message: `관리자가 ${setAdmin ? "지정" : "해제"}되었습니다.`,
        role: user.role,
      });
    } catch (err) {
      console.error("관리자 토글 에러:", err);
      res.status(500).json({ message: "서버 에러" });
    }
  }
);

// 게임 기록 초기화 API 추가
app.delete("/api/admin/reset-game-history", auth("admin"), async (req, res) => {
  try {
    await Game.deleteMany({});
    console.log("게임 기록이 초기화되었습니다.");
    res.json({ message: "게임 기록이 초기화되었습니다." });
  } catch (err) {
    console.error("게임 기록 초기화 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 환전 요청 스키마 추가
const exchangeRequestSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  username: String,
  requestAmount: Number,
  actualAmount: Number,
  fee: Number,
  totalBets: Number, // 총 베팅액
  rollingPoint: Number, // 롤링 포인트
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  usedBets: {
    type: Number,
    default: 0,
  },
});

const ExchangeRequest = mongoose.model(
  "ExchangeRequest",
  exchangeRequestSchema
);

// 환전 신청 API 수정
app.post("/api/exchange/request", auth(), async (req, res) => {
  const { amount } = req.body;

  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    // 최소 환전 가능 코인 체크 (5코인)
    if (amount < 5) {
      return res
        .status(400)
        .json({ message: "최소 5코인부터 환전 가능합니다." });
    }

    if (user.coins < amount) {
      return res.status(400).json({ message: "보유 코인이 부족합니다." });
    }

    // 롤링 요구사항 체크 (총 베팅액의 100%)
    const totalBets = user.bettingHistory.reduce(
      (sum, bet) => sum + bet.coins,
      0
    );
    const rollingPoint = Math.floor(totalBets * 1.0); // 100%의 롤 포인트

    // 롤링 요구사항 충족 확인
    if (rollingPoint < amount) {
      return res.status(400).json({
        message: `롤링 요구사항이 부족합니다. 현재 환전 가능 코인: ${rollingPoint}`,
        rollingPoint,
        totalBets,
      });
    }

    // 수수료 계산 수정 (10코인 미만은 1코인, 10코인 이상은 5코인당 1코인)
    const fee = amount < 10 ? 1 : Math.ceil(amount / 5);
    const actualAmount = amount - fee;

    // 환전 요청 생성
    const exchangeRequest = new ExchangeRequest({
      userId: user._id,
      username: user.username,
      requestAmount: amount,
      actualAmount: actualAmount,
      totalBets,
      rollingPoint,
      fee,
      usedBets: amount, // 환전에 사용된 베팅액 저장
    });

    // 사용자 코인 차감
    user.coins -= amount;

    // 사용된 베팅액 기록 (새로운 필드 추가)
    if (!user.usedBetsForExchange) {
      user.usedBetsForExchange = 0;
    }
    user.usedBetsForExchange += amount;

    await Promise.all([exchangeRequest.save(), user.save()]);

    // 남은 환전 가능 금액 계산
    const remainingRollingPoint = Math.max(
      0,
      rollingPoint - user.usedBetsForExchange
    );

    res.json({
      message: "환전 신청이 완료되었습니다.",
      actualAmount,
      fee,
      rollingPoint: remainingRollingPoint, // 남은 환전 가능 금액 반환
      totalBets,
    });
  } catch (err) {
    console.error("환전 신청 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 사용자의 환전 내역 조회 API
app.get("/api/exchange/history", auth(), async (req, res) => {
  try {
    const exchanges = await ExchangeRequest.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    res.json(exchanges);
  } catch (err) {
    console.error("환 내 조회 러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 관리자용 환전 요청 목록 조회 API
app.get("/api/admin/exchange-requests", auth("admin"), async (req, res) => {
  try {
    const requests = await ExchangeRequest.find()
      .sort({ createdAt: -1 })
      .lean();
    res.json(requests);
  } catch (err) {
    console.error("환전 요청 조회 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 환전 요청 처리 API
app.put("/api/admin/exchange-requests/:id", auth("admin"), async (req, res) => {
  const { status } = req.body;

  try {
    const request = await ExchangeRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ message: "요청을 찾을 수 없습니다." });
    }

    if (request.status !== "pending") {
      return res.status(400).json({ message: "이미 처리된 요청입니다." });
    }

    request.status = status;
    await request.save();

    // 거절된 경우 코인 반환
    if (status === "rejected") {
      const user = await User.findById(request.userId);
      if (user) {
        user.coins += request.requestAmount;
        await user.save();
      }
    }

    res.json({
      message: `환 요청이 ${status === "approved" ? "인" : "거"}었습니다.`,
    });
  } catch (err) {
    console.error("환전 요청 처리 에러:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================
// 서버 시작
// =====================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중`);
});
