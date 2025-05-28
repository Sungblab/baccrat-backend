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
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://golden-baccratt.netlify.app";

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
  .then(() => {})
  .catch((err) => {});

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
  balance: {
    type: Number,
    default: 10000,
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
      choice: {
        type: String,
        enum: ["player", "banker", "tie", "player_pair", "banker_pair"],
      },
      amount: Number,
      result: { type: String, enum: ["win", "lose", "draw"] },
      gameResult: { type: String, enum: ["player", "banker", "tie"] },
      date: { type: Date, default: Date.now },
    },
  ],
  rollingBalance: {
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

    res.json({
      username: user.username,
      balance: user.balance,
      bettingHistory: user.bettingHistory,
      rollingBalance: user.rollingBalance || 0,
    });
  } catch (err) {
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

      // 사용자 순손익 계산
      let netProfit = 0;
      if (user.bettingHistory && user.bettingHistory.length > 0) {
        user.bettingHistory.forEach((bet) => {
          const betAmount = bet.amount;
          if (bet.result === "win") {
            if (bet.choice === "player") {
              netProfit += betAmount; // 플레이어 승리: 베팅액 1배 수익 (총 2배 지급)
            } else if (bet.choice === "banker") {
              netProfit += betAmount * 0.95; // 뱅커 승리: 베팅액 0.95배 수익 (총 1.95배 지급)
            } else if (bet.choice === "tie") {
              netProfit += betAmount * 4; // 타이 승리: 베팅액 4배 수익 (총 5배 지급)
            } else if (
              bet.choice === "player_pair" ||
              bet.choice === "banker_pair"
            ) {
              netProfit += betAmount * 10; // 페어 승리: 베팅액 10배 수익 (총 11배 지급)
            }
          } else if (bet.result === "lose") {
            netProfit -= betAmount; // 패배: 베팅액만큼 손실
          }
          // 무승부 (P/B 베팅 후 타이 결과): 순손익 0 (원금 반환)이므로 별도 처리 안함
        });
      }

      return {
        _id: user._id,
        username: user.username,
        balance: user.balance,
        role: user.role,
        isApproved: user.isApproved,
        wins,
        losses,
        totalBets,
        winRate,
        netProfit: netProfit, // 순손익 추가
      };
    });

    res.json(stats);
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// 리더보드 API 수정
app.get("/api/admin/leaderboard", auth("admin"), async (req, res) => {
  try {
    const users = await User.find().select("username balance bettingHistory");

    const leaderboard = users.map((user) => {
      const stats = user.bettingHistory.reduce(
        (acc, bet) => {
          acc.totalBets++;
          acc.totalCoins += bet.amount;
          if (bet.result === "win") acc.wins++;
          return acc;
        },
        { totalBets: 0, totalCoins: 0, wins: 0 }
      );

      return {
        username: user.username,
        balance: user.balance,
        totalBets: stats.totalBets,
        winRate:
          stats.totalBets > 0
            ? ((stats.wins / stats.totalBets) * 100).toFixed(1)
            : 0,
        totalWagered: stats.totalCoins,
      };
    });

    // 코인 보유량으로 정렬
    leaderboard.sort((a, b) => b.balance - a.balance);

    res.json(leaderboard);
  } catch (err) {
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

      user.balance += parseInt(adjustment);
      if (user.balance < 0) user.balance = 0;
      await user.save();

      res.json({
        message: `코인이 조정되었습니다. 현재 코인: ${user.balance}`,
        balance: user.balance,
      });
    } catch (err) {
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
          amount: bet.amount,
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
    res.status(500).json({ message: "서버 에러" });
  }
});

// 수익 계산 함수 수정
function calculateProfit(bet) {
  try {
    if (bet.result === "win") {
      if (bet.choice === "tie") {
        return bet.amount * 5;
      }
      return bet.amount * 2;
    } else if (bet.result === "draw") {
      return 0;
    }
    return -bet.amount;
  } catch (error) {
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
      stats[bet.choice].total += bet.amount;
      totalBets += bet.amount;
      uniquePlayers.add(bet.userId);

      // 수익/손실 계산
      const profit = calculateProfit({
        choice: bet.choice,
        amount: bet.amount,
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

    // 현재 베팅 내역을 처리
    for (const bet of currentBets) {
      try {
        const user = await User.findById(bet.userId);
        if (!user) continue;

        let outcome = "lose"; // 기본적으로 lose로 설정
        let winningsToAdd = 0; // 잔액에 추가될 최종 금액 (원금 포함된 배당금 또는 원금만)

        // 주 베팅 (P/B/T) 결과 처리
        if (["player", "banker", "tie"].includes(bet.choice)) {
          if (result === "tie") {
            if (bet.choice === "tie") {
              winningsToAdd = bet.amount * 5; // 타이 당첨 (5배)
              outcome = "win";
            } else {
              winningsToAdd = bet.amount; // P/B 베팅 후 타이 시 원금 반환
              outcome = "draw";
            }
          } else {
            // P 또는 B 승리 시
            if (bet.choice === result) {
              if (bet.choice === "banker") {
                winningsToAdd = bet.amount * 1.95; // 뱅커 당첨 (1.95배)
              } else {
                // player
                winningsToAdd = bet.amount * 2; // 플레이어 당첨 (2배)
              }
              outcome = "win";
            }
            // 패배 시 winningsToAdd는 0이므로 잔액 변동 없음 (이미 베팅시 차감)
          }
        }

        // 페어 베팅 결과 처리 (주 베팅과 별개로 정산)
        if (
          bet.choice === "player_pair" &&
          currentGameResult.playerPairOccurred
        ) {
          winningsToAdd += bet.amount * 11; // 플레이어 페어 당첨 (11배) - 주 베팅 결과와 합산될 수 있음
          if (outcome === "lose")
            outcome = "win"; // 주 베팅이 패배라도 페어가 맞으면 승리
          else if (outcome === "draw") outcome = "win"; // 무승부였어도 페어 맞으면 승리
        }
        if (
          bet.choice === "banker_pair" &&
          currentGameResult.bankerPairOccurred
        ) {
          winningsToAdd += bet.amount * 11; // 뱅커 페어 당첨 (11배)
          if (outcome === "lose") outcome = "win";
          else if (outcome === "draw") outcome = "win";
        }

        user.balance += winningsToAdd;

        // 롤링 포인트 적립 (베팅액만큼)
        user.rollingBalance = (user.rollingBalance || 0) + bet.amount;

        user.bettingHistory.push({
          choice: bet.choice,
          amount: bet.amount,
          result: outcome,
          gameResult: result,
          date: new Date(),
        });

        await user.save();
      } catch (err) {}
    }

    // 결과 전송
    io.emit("result_approved");
    io.emit("update_coins"); // 클라이언트가 잔액 업데이트 하도록 알림 (이름 변경 고려)

    // 상태 초기화
    currentBets = [];
    currentBettingStats = {
      player: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      banker: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      tie: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      player_pair: {
        count: 0,
        total: 0,
        bettor_count: 0,
        total_bet_amount: 0,
      },
      banker_pair: {
        count: 0,
        total: 0,
        bettor_count: 0,
        total_bet_amount: 0,
      },
    };
    currentGameResult = null;

    // 초기화된 통계를 포함하여 베팅 상태를 모든 클라이언트에 즉시 전송
    io.emit("betting_status", {
      active: bettingActive,
      endTime: bettingEndTime,
      stats: currentBettingStats,
    });

    // 모든 유저에게 빈 개인 베팅 현황 전송 (초기화)
    // io.emit("my_bets_updated", { myCurrentBetsOnChoices: {} }); // 중복 제거

    res.json({
      message: "게임 결과가 설정되고 사용자 코인이 업데이트되었습니다.",
    });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================
// Socket.io 설정 및 베팅 로직
// =====================
let currentBets = []; // 현재 베팅 내역 저장
let bettingActive = false; // 베팅 활성 상태
let bettingEndTime = null; // 베팅 종료 시간

// Debounce user balance saves
const pendingUserSaves = new Map(); // <userId, NodeJS.Timeout>
const userBalanceUpdates = new Map(); // <userId, number> stores cumulative deduction amount

let currentBettingStats = {
  player: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
  banker: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
  tie: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
  player_pair: {
    count: 0,
    total: 0,
    bettor_count: 0,
    total_bet_amount: 0,
  },
  banker_pair: {
    count: 0,
    total: 0,
    bettor_count: 0,
    total_bet_amount: 0,
  },
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
    const { choice, amount, token } = betData;
    console.log("베팅 요청 받음:", { choice, amount });

    if (!bettingActive) {
      console.log("베팅 비활성화 상태");
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

      // Calculate current effective balance
      const pendingDeduction = userBalanceUpdates.get(userId) || 0;
      const effectiveBalance = user.balance - pendingDeduction;

      // 베팅 제한 확인
      if (
        !["player", "banker", "tie", "player_pair", "banker_pair"].includes(
          choice
        )
      ) {
        return socket.emit("error", "유효하지 않은 선택입니다.");
      }

      // 베팅 금액 한도 (1,000원 ~ 500,000원)
      if (amount < 1000 || amount > 500000) {
        return socket.emit(
          "error",
          "베팅 금액은 1,000원에서 500,000원 사이여야 합니다."
        );
      }

      if (effectiveBalance < amount) {
        return socket.emit("error", "잔액이 부족합니다.");
      }

      // Update pending deduction for this user
      userBalanceUpdates.set(
        userId,
        (userBalanceUpdates.get(userId) || 0) + amount
      );

      // Clear any existing save timeout for this user
      if (pendingUserSaves.has(userId)) {
        clearTimeout(pendingUserSaves.get(userId));
      }

      // Schedule a debounced save
      pendingUserSaves.set(
        userId,
        setTimeout(async () => {
          try {
            const userToUpdate = await User.findById(userId);
            if (userToUpdate) {
              const totalDeduction = userBalanceUpdates.get(userId) || 0;
              userToUpdate.balance -= totalDeduction;
              await userToUpdate.save();
              userBalanceUpdates.delete(userId); // Clear pending update for this user
              pendingUserSaves.delete(userId);
              // Optionally emit an event to the user confirming balance save if needed
              // socket.emit("balance_saved", { newBalance: userToUpdate.balance });
            }
          } catch (err) {
            // Handle error during debounced save
          }
        }, 500)
      ); // 500ms debounce time

      // 베팅 저장
      const bet = {
        userId,
        choice,
        amount,
        username: user.username,
      };

      // 사용자가 해당 선택지에 이 베팅 이전에 다른 베팅을 했는지 확인
      // currentBets에 현재 bet을 추가하기 전에 확인합니다.
      const previousBetsOnThisChoiceByThisUser = currentBets.find(
        (b) => b.userId === userId && b.choice === choice
      );

      currentBets.push(bet); // 이제 현재 베팅을 추가

      currentBettingStats[choice].count++;
      currentBettingStats[choice].total += amount;

      if (!previousBetsOnThisChoiceByThisUser) {
        // 이 유저의 이 선택지에 대한 첫 베팅인 경우
        currentBettingStats[choice].bettor_count++;
      }
      currentBettingStats[choice].total_bet_amount += amount;

      // 모든 클라이언트에게 새로운 베팅 정보 전송 (업데이트된 통계 포함)
      io.emit("new_bet", {
        choice,
        stats: currentBettingStats, // 전체 통계 객체 전달
      });

      socket.emit("bet_success", "베팅이 완료되었습니다.");

      // 해당 유저의 선택지별 총 베팅액 계산
      const myCurrentBetsOnChoices = currentBets.reduce((acc, curBet) => {
        if (curBet.userId === userId) {
          acc[curBet.choice] = (acc[curBet.choice] || 0) + curBet.amount;
        }
        return acc;
      }, {});
      socket.emit("my_bets_updated", { myCurrentBetsOnChoices });

      console.log(
        `사용자 ${user.username}이(가) 베팅: ${choice}, 금액: ${amount}원`
      );
    } catch (err) {
      socket.emit("error", "베팅 처리 중 오류가 발생했습니다.");
    }
  });

  socket.on("cancel_bet", async (data) => {
    const { token } = data; // 토큰만 받아도 사용자 식별 가능
    console.log("베팅 취소 요청 받음");

    if (!bettingActive) {
      return socket.emit("error", "베팅 시간이 종료되어 취소할 수 없습니다.");
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

      // currentBets 배열에서 해당 사용자의 가장 마지막 베팅 찾기
      let lastBetIndex = -1;
      for (let i = currentBets.length - 1; i >= 0; i--) {
        if (currentBets[i].userId === userId) {
          lastBetIndex = i;
          break;
        }
      }

      if (lastBetIndex === -1) {
        return socket.emit("error", "취소할 베팅을 찾을 수 없습니다.");
      }

      const betToCancel = currentBets[lastBetIndex];

      // currentBets에서 해당 베팅 제거
      currentBets.splice(lastBetIndex, 1);

      // 사용자 잔액 복원 (메모리에서만, DB 저장은 debounce)
      // Update pending balance change for this user (add back the cancelled amount)
      const currentPendingChange = userBalanceUpdates.get(userId) || 0;
      userBalanceUpdates.set(userId, currentPendingChange - betToCancel.amount); // Subtracting a "deduction" means adding back

      // Clear any existing save timeout for this user
      if (pendingUserSaves.has(userId)) {
        clearTimeout(pendingUserSaves.get(userId));
        pendingUserSaves.delete(userId);
      }

      // Schedule/Reschedule a debounced save
      // The timeout will apply the net change from userBalanceUpdates
      pendingUserSaves.set(
        userId,
        setTimeout(async () => {
          try {
            const userToUpdate = await User.findById(userId);
            if (userToUpdate) {
              const netChange = userBalanceUpdates.get(userId) || 0;
              // Apply netChange to the balance fetched from DB
              // If netChange is negative (bets > cancels), balance decreases.
              // If netChange is positive (cancels > bets, or just cancels), balance increases.
              userToUpdate.balance -= netChange; // Since userBalanceUpdates stores deductions as positive
              await userToUpdate.save();

              userBalanceUpdates.delete(userId); // Clear pending update for this user
              pendingUserSaves.delete(userId);
              // Optionally emit an event to the user confirming balance save
              // socket.emit("balance_saved", { newBalance: userToUpdate.balance });
            }
          } catch (err) {
            // Handle error during debounced save
            // Consider how to retry or log this critical failure
          }
        }, 500)
      ); // 500ms debounce time

      // 베팅 통계 업데이트 (차감)
      if (currentBettingStats[betToCancel.choice]) {
        currentBettingStats[betToCancel.choice].count = Math.max(
          0,
          currentBettingStats[betToCancel.choice].count - 1
        );
        currentBettingStats[betToCancel.choice].total = Math.max(
          0,
          currentBettingStats[betToCancel.choice].total - betToCancel.amount
        );

        // 취소 후, 해당 유저가 이 선택지에 다른 베팅을 가지고 있는지 확인
        const otherBetsOnThisChoiceFromUserAfterCancel = currentBets.find(
          (b) => b.userId === userId && b.choice === betToCancel.choice
        );

        if (!otherBetsOnThisChoiceFromUserAfterCancel) {
          // 다른 베팅이 없다면 bettor_count 감소
          currentBettingStats[betToCancel.choice].bettor_count = Math.max(
            0,
            currentBettingStats[betToCancel.choice].bettor_count - 1
          );
        }
        currentBettingStats[betToCancel.choice].total_bet_amount = Math.max(
          0,
          currentBettingStats[betToCancel.choice].total_bet_amount -
            betToCancel.amount
        );
      }

      // 모든 클라이언트에게 업데이트된 베팅 통계 전송
      io.emit("new_bet", {
        choice: betToCancel.choice, // 어떤 베팅이 영향을 받았는지 알려주기 위함 (UI 업데이트용)
        stats: currentBettingStats,
      });

      // 해당 사용자에게 베팅 취소 성공 알림 및 업데이트된 잔액 전송
      socket.emit("bet_cancelled_success", {
        message: `베팅(선택: ${betToCancel.choice}, 금액: ${betToCancel.amount}원)이 취소되었습니다.`,
        newBalance: user.balance,
        cancelledBet: betToCancel,
      });
      io.emit("update_coins"); // 다른 유저에게도 (필요하다면) 코인 업데이트 (여기서는 잔액 변화가 특정 유저에게만 해당)

      // 해당 유저의 선택지별 총 베팅액 다시 계산하여 전송
      const myCurrentBetsOnChoicesAfterCancel = currentBets.reduce(
        (acc, curBet) => {
          if (curBet.userId === userId) {
            acc[curBet.choice] = (acc[curBet.choice] || 0) + curBet.amount;
          }
          return acc;
        },
        {}
      );
      socket.emit("my_bets_updated", {
        myCurrentBetsOnChoices: myCurrentBetsOnChoicesAfterCancel,
      });

      console.log(
        `사용자 ${user.username}의 베팅 취소: ${betToCancel.choice}, 금액: ${betToCancel.amount}원`
      );
    } catch (err) {
      socket.emit("error", "베팅 취소 처리 중 오류가 발생했습니다.");
    }
  });

  // 게임 결과 처리 이벤트 핸들러 수정
  socket.on("game_result", async (data) => {
    const {
      result,
      playerScore,
      bankerScore,
      timestamp,
      playerPairOccurred,
      bankerPairOccurred,
    } = data; // 페어 정보 직접 수신

    // 현재 게임 결과 저장 (페어 정보 포함)
    currentGameResult = {
      result,
      playerScore,
      bankerScore,
      timestamp: timestamp || new Date().toISOString(),
      playerPairOccurred: playerPairOccurred || false,
      bankerPairOccurred: bankerPairOccurred || false,
      stats: currentBettingStats,
      totalBets: currentBets.reduce((sum, bet) => sum + bet.amount, 0),
      playerCount: new Set(currentBets.map((bet) => bet.userId)).size,
    };

    // 관리자에게 결과 전달 (페어 정보 포함)
    io.emit("game_result", currentGameResult);
    console.log("게임 결과 수신 (페어 포함):", currentGameResult);
  });

  let resultProcessing = false; // 결과 처리 중복 방지 플래그는 유지

  // 결과 승인 처리 수정
  socket.on("approve_result", async (approvedGameData) => {
    if (resultProcessing) {
      return;
    }
    resultProcessing = true;

    // Flush all pending balance saves before processing results
    for (const [userId, timeoutId] of pendingUserSaves) {
      clearTimeout(timeoutId);
      try {
        const userToUpdate = await User.findById(userId);
        if (userToUpdate) {
          const netChange = userBalanceUpdates.get(userId) || 0;
          userToUpdate.balance -= netChange; // Apply net deduction
          await userToUpdate.save();
          userBalanceUpdates.delete(userId);
        }
      } catch (err) {
        console.error(`Error flushing balance for user ${userId}:`, err);
      }
    }
    pendingUserSaves.clear(); // All pending saves have been processed or attempted

    try {
      // approvedGameData가 없거나, 필요한 result 필드가 없으면 오류 처리
      if (!approvedGameData || !approvedGameData.result) {
        // 기존의 currentGameResult를 사용하거나 오류 반환
        if (!currentGameResult) {
          throw new Error("승인할 게임 결과 데이터가 없습니다.");
        }
        // approvedGameData가 없을 경우, 기존의 currentGameResult를 사용 (페어 정보 X)
        console.warn(
          "approvedGameData가 제공되지 않아 기존 currentGameResult를 사용합니다."
        );
      } else {
        // admin.html에서 보낸 상세 데이터로 currentGameResult를 설정하거나 업데이트
        // 이전에 socket.on("game_result", ...) 에서 설정된 stats, totalBets, playerCount 등을 유지하기 위해
        // approvedGameData의 정보를 기존 currentGameResult에 병합합니다.
        currentGameResult = {
          ...(currentGameResult || {}), // 기존 currentGameResult가 null일 수 있으므로 초기값 제공
          result: approvedGameData.result,
          playerPairOccurred: approvedGameData.playerPairOccurred || false,
          bankerPairOccurred: approvedGameData.bankerPairOccurred || false,
          timestamp: approvedGameData.timestamp
            ? new Date(approvedGameData.timestamp)
            : new Date(),
          // 만약 approvedGameData에 playerScore, bankerScore가 있다면 그것도 반영 가능
          // 예: playerScore: approvedGameData.playerScore,
          //     bankerScore: approvedGameData.bankerScore,
        };
      }

      if (!currentGameResult || !currentGameResult.result) {
        // 최종적으로 currentGameResult와 result 필드가 유효한지 다시 한번 확인
        throw new Error("승인할 최종 게임 결과 정보(result 포함)가 없습니다.");
      }

      // 게임 결과 저장 시 페어 발생 여부 포함
      const game = new Game({
        result: currentGameResult.result,
        playerPairOccurred: currentGameResult.playerPairOccurred || false,
        bankerPairOccurred: currentGameResult.bankerPairOccurred || false,
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

          let outcome = "lose"; // 기본적으로 lose로 설정
          let winningsToAdd = 0; // 잔액에 추가될 최종 금액 (원금 포함된 배당금 또는 원금만)

          // 주 베팅 (P/B/T) 결과 처리
          if (["player", "banker", "tie"].includes(bet.choice)) {
            if (currentGameResult.result === "tie") {
              if (bet.choice === "tie") {
                winningsToAdd = bet.amount * 5; // 타이 당첨 (5배)
                outcome = "win";
              } else {
                winningsToAdd = bet.amount; // P/B 베팅 후 타이 시 원금 반환
                outcome = "draw";
              }
            } else {
              // P 또는 B 승리 시
              if (bet.choice === currentGameResult.result) {
                if (bet.choice === "banker") {
                  winningsToAdd = bet.amount * 1.95; // 뱅커 당첨 (1.95배)
                } else {
                  // player
                  winningsToAdd = bet.amount * 2; // 플레이어 당첨 (2배)
                }
                outcome = "win";
              }
              // 패배 시 winningsToAdd는 0이므로 잔액 변동 없음 (이미 베팅시 차감)
            }
          }

          // 페어 베팅 결과 처리 (주 베팅과 별개로 정산)
          if (
            bet.choice === "player_pair" &&
            currentGameResult.playerPairOccurred
          ) {
            winningsToAdd += bet.amount * 11; // 플레이어 페어 당첨 (11배) - 주 베팅 결과와 합산될 수 있음
            if (outcome === "lose")
              outcome = "win"; // 주 베팅이 패배라도 페어가 맞으면 승리
            else if (outcome === "draw") outcome = "win"; // 무승부였어도 페어 맞으면 승리
          }
          if (
            bet.choice === "banker_pair" &&
            currentGameResult.bankerPairOccurred
          ) {
            winningsToAdd += bet.amount * 11; // 뱅커 페어 당첨 (11배)
            if (outcome === "lose") outcome = "win";
            else if (outcome === "draw") outcome = "win";
          }

          user.balance += winningsToAdd;

          // 롤링 포인트 적립 (베팅액만큼)
          user.rollingBalance = (user.rollingBalance || 0) + bet.amount;

          // 베팅 기록 추가
          user.bettingHistory.push({
            choice: bet.choice,
            amount: bet.amount,
            result: outcome,
            gameResult: currentGameResult.result, // 주 게임 결과 기록
            // 페어 결과는 여기서 별도로 기록할 수도 있음 (예: gameResultDetails: { playerPair: true })
            date: new Date(),
          });

          await user.save();
        } catch (err) {}
      }

      // 결과 전송
      io.emit("result_approved");
      io.emit("update_coins"); // 클라이언트가 잔액 업데이트 하도록 알림 (이름 변경 고려)

      // 상태 초기화
      currentBets = [];
      currentBettingStats = {
        player: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
        banker: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
        tie: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
        player_pair: {
          count: 0,
          total: 0,
          bettor_count: 0,
          total_bet_amount: 0,
        },
        banker_pair: {
          count: 0,
          total: 0,
          bettor_count: 0,
          total_bet_amount: 0,
        },
      };
      currentGameResult = null;

      // 초기화된 통계를 포함하여 베팅 상태를 모든 클라이언트에 즉시 전송
      io.emit("betting_status", {
        active: bettingActive,
        endTime: bettingEndTime,
        stats: currentBettingStats,
      });

      // 모든 유저에게 빈 개인 베팅 현황 전송 (초기화)
      // io.emit("my_bets_updated", { myCurrentBetsOnChoices: {} }); // 중복 제거

      res.json({
        message: "게임 결과가 설정되고 사용자 코인이 업데이트되었습니다.",
      });
    } catch (err) {
      socket.emit("error", "게임 결과 승인 처리 중 오류가 발생했습니다.");
    } finally {
      resultProcessing = false; // 처리 완료 플래그 해제
    }
  });

  // 결과 거절 처리
  socket.on("reject_result", () => {
    currentGameResult = null; // 현재 게임 결과 초기화
    io.emit("result_rejected");
  });

  socket.on("disconnect", () => {});

  // game.html로부터 카드 정보를 받아 user.html로 전달하는 로직
  socket.on("card_dealt_to_user_ui", (data) => {
    // console.log("[server.js] Received card_dealt_to_user_ui from game.html:", data);
    let displayValue = data.cardValue;
    if (["K", "Q", "J", "0"].includes(data.cardValue)) {
      displayValue = "0";
    } else if (data.cardValue === "T") {
      displayValue = "0";
    } else if (data.cardValue === "A") {
      displayValue = "A";
    }
    // 다른 숫자 카드(2-9)는 그대로 data.cardValue 사용

    const dataForUserHtml = {
      target: data.target,
      cardValue: displayValue, // 변환된 값
      cardSuit: data.cardSuit, // cardSuit 추가
      cardIndex: data.cardIndex,
      isNewHand: data.isNewHand,
    };
    // console.log("[server.js] Emitting display_card_on_user_html to user.html:", dataForUserHtml);
    io.emit("display_card_on_user_html", dataForUserHtml); // 모든 user.html 클라이언트에 브로드캐스트
  });

  socket.on("clear_cards_on_user_ui", () => {
    // console.log("[server.js] Received clear_cards_on_user_ui from game.html, emitting to user.html");
    io.emit("clear_cards_display_on_user_html"); // user.html의 카드 표시 클리어 이벤트
  });

  // 개인 베팅 금액 표시 초기화를 위한 my_bets_updated 이벤트 수신
  socket.on("my_bets_updated", (data) => {
    updateMyBetAmounts(data.myCurrentBetsOnChoices);
  });
});

// 게임 기록 스키마 및 모델 정의
const gameSchema = new mongoose.Schema({
  result: {
    type: String,
    enum: ["player", "banker", "tie"],
    required: true,
  },
  playerPairOccurred: { type: Boolean, default: false }, // 플레이어 페어 발생 여부
  bankerPairOccurred: { type: Boolean, default: false }, // 뱅커 페어 발생 여부
  date: {
    type: Date,
    default: Date.now,
  },
  stats: {
    player: {
      count: { type: Number, default: 0 },
      total: { type: Number, default: 0 }, // 원 단위 총 베팅액
    },
    banker: {
      count: { type: Number, default: 0 },
      total: { type: Number, default: 0 }, // 원 단위 총 베팅액
    },
    tie: {
      count: { type: Number, default: 0 },
      total: { type: Number, default: 0 }, // 원 단위 총 베팅액
    },
    player_pair: {
      // 플레이어 페어 통계 추가
      count: { type: Number, default: 0 },
      total: { type: Number, default: 0 }, // 원 단위 총 베팅액
    },
    banker_pair: {
      // 뱅커 페어 통계 추가
      count: { type: Number, default: 0 },
      total: { type: Number, default: 0 }, // 원 단위 총 베팅액
    },
  },
  totalBets: { type: Number, default: 0 }, // 원 단위 총 베팅액
  playerCount: { type: Number, default: 0 },
});

const Game = mongoose.model("Game", gameSchema);

// 최근 게임 결과 API 수정
app.get("/api/recent-games", async (req, res) => {
  try {
    const recentGames = await Game.find()
      .select("result date stats totalBets playerCount")
      .sort({ date: -1 })
      .limit(36)
      .lean();

    res.json(recentGames);
  } catch (err) {
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
      res.status(500).json({ message: "서버 에러" });
    }
  }
);

// 게임 기록 초기화 API 추가
app.delete("/api/admin/reset-game-history", auth("admin"), async (req, res) => {
  try {
    await Game.deleteMany({});
    res.json({ message: "게임 기록이 초기화되었습니다." });
  } catch (err) {
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
  requestAmount: Number, // 원 단위로 가정
  actualAmount: Number, // 원 단위로 가정
  fee: Number, // 원 단위로 가정
  // totalBets: Number, // 총 베팅액 (원 단위) - 주석 처리 또는 삭제
  // rollingPoint: Number, // 롤링 포인트 (원 단위) - 주석 처리 또는 삭제
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  // usedAmount: { // 'usedBets'에서 'usedAmount'로 변경 - 주석 처리 또는 삭제
  //   type: Number,
  //   default: 0,
  // },
});

const ExchangeRequest = mongoose.model(
  "ExchangeRequest",
  exchangeRequestSchema
);

// 환전 신청 API 수정
app.post("/api/exchange/request", auth(), async (req, res) => {
  const { amount } = req.body; // amount는 원 단위

  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    // 최소 환전 가능 금액 체크 (5,000원)
    if (amount < 5000) {
      return res
        .status(400)
        .json({ message: "최소 5,000원부터 환전 가능합니다." });
    }

    if (user.balance < amount) {
      return res.status(400).json({ message: "보유 잔액이 부족합니다." });
    }

    // 롤링 요구사항 체크 (사용 가능한 롤링 포인트가 신청 금액 이상이어야 함)
    if ((user.rollingBalance || 0) < amount) {
      return res.status(400).json({
        message: `롤링 포인트가 부족합니다. 현재 사용 가능 롤링 포인트: ${(
          user.rollingBalance || 0
        ).toLocaleString()}원`,
        rollingBalance: user.rollingBalance || 0,
      });
    }

    // 새로운 수수료 계산
    let fee = 0;
    if (amount < 50000) {
      fee = 1000;
    } else if (amount < 200000) {
      fee = 2000;
    } else {
      fee = Math.floor(amount * 0.01);
    }
    const actualAmount = amount - fee;

    // 환전 요청 생성
    const exchangeRequest = new ExchangeRequest({
      userId: user._id,
      username: user.username,
      requestAmount: amount,
      actualAmount: actualAmount,
      fee,
      // totalBets, rollingPoint 필드는 ExchangeRequest 스키마에서 제거하거나 주석 처리 필요 (user.rollingBalance를 직접 사용하므로)
      // status, createdAt 등은 스키마 기본값 사용
    });

    // 사용자 잔액 차감
    user.balance -= amount;
    // 사용된 롤링 포인트 차감
    user.rollingBalance = (user.rollingBalance || 0) - amount;

    await Promise.all([exchangeRequest.save(), user.save()]);

    res.json({
      message: "환전 신청이 완료되었습니다.",
      requestAmount: amount,
      actualAmount,
      fee,
      newBalance: user.balance,
      newRollingBalance: user.rollingBalance,
    });
  } catch (err) {
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
        user.balance += request.requestAmount;
        await user.save();
      }
    }

    res.json({
      message: `환 요청이 ${status === "approved" ? "인" : "거"}었습니다.`,
    });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================
// 서버 시작
// =====================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {});
