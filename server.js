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
  origin: [FRONTEND_URL, "http://127.0.0.1:5500"],
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
  rollingDeposit: { type: Number, default: 0 }, // 롤링 대상이 되는 누적 충전액
  rollingWagered: { type: Number, default: 0 }, // 롤링을 위해 누적된 베팅액
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

    user = new User({ username, password }); // 기본 잔액 수는 스키마에서 설정

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

    // 환전 가능 금액 계산: 베팅한 금액만큼 환전 가능
    const rollingRequirement = (user.rollingDeposit || 0) * 1.5;
    const rollingWagered = user.rollingWagered || 0;
    // 베팅한 금액만큼은 언제든지 환전 가능
    const maxExchangeAmount = Math.min(user.balance, rollingWagered);

    res.json({
      username: user.username,
      balance: user.balance,
      bettingHistory: user.bettingHistory,
      rollingDeposit: user.rollingDeposit || 0,
      rollingWagered: rollingWagered,
      maxExchangeAmount,
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

      // 사용자 순손익 계산 (calculateProfit 함수와 동일한 로직 사용)
      let netProfit = 0;
      if (user.bettingHistory && user.bettingHistory.length > 0) {
        user.bettingHistory.forEach((bet) => {
          const profit = calculateProfit(bet);
          netProfit += profit;
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

    // 잔액 보유량으로 정렬
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

// 잔액 조절하기
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

      // 해당 사용자에게 실시간으로 잔액 업데이트 알림
      const userSocket = userSockets.get(user._id.toString());
      if (userSocket) {
        userSocket.emit("balance_updated", {
          newBalance: user.balance,
        });
      }

      // 모든 관리자에게 사용자 잔액 변경 알림
      io.emit("user_balance_updated", {
        userId: user._id.toString(),
        newBalance: user.balance,
      });

      res.json({
        message: `잔액액이 조정되었습니다. 현재 잔액: ${user.balance}`,
        balance: user.balance,
        newBalance: user.balance, // 관리자 페이지에서 사용할 새 잔액 정보
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
      if (bet.choice === "player") {
        return bet.amount; // 플레이어 승리: 베팅액 1배 수익 (총 2배 지급)
      } else if (bet.choice === "banker") {
        return bet.amount * 0.95; // 뱅커 승리: 베팅액 0.95배 수익 (총 1.95배 지급)
      } else if (bet.choice === "tie") {
        return bet.amount * 4; // 타이 승리: 베팅액 4배 수익 (총 5배 지급)
      } else if (bet.choice === "player_pair" || bet.choice === "banker_pair") {
        return bet.amount * 10; // 페어 승리: 베팅액 10배 수익 (총 11배 지급)
      }
    } else if (bet.result === "draw") {
      return 0; // 무승부: 원금 반환이므로 손익 0
    } else if (bet.result === "lose") {
      return -bet.amount; // 패배: 베팅액만큼 손실
    }
    return 0;
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

        // 롤링 포인트 적립 (베팅액만큼만)
        user.rollingWagered = (user.rollingWagered || 0) + bet.amount;

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
      message: "게임 결과가 설정되고 사용자 잔액이 업데이트되었습니다.",
    });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================
// 바카라 게임 로직
// =====================
class BaccaratGame {
  constructor() {
    this.deck = [];
    this.numberOfDecks = 8;
    this.reshufflePoint = 52 * 2;
    this.initializeDeck();
    this.shuffleDeck();
  }

  initializeDeck() {
    const suits = ["H", "D", "C", "S"]; // Hearts, Diamonds, Clubs, Spades
    const values = [
      "A",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "0", // 10을 0으로 표현 (deckofcardsapi.com 형식)
      "J",
      "Q",
      "K",
    ];
    this.deck = [];

    for (let d = 0; d < this.numberOfDecks; d++) {
      for (let suit of suits) {
        for (let value of values) {
          this.deck.push({ suit, value, id: `${value}${suit}_${d}` });
        }
      }
    }
  }

  shuffleDeck() {
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  drawCard() {
    if (this.deck.length < this.reshufflePoint) {
      this.initializeDeck();
      this.shuffleDeck();
    }
    return this.deck.pop();
  }

  getCardValue(card) {
    if (["J", "Q", "K", "0"].includes(card.value)) return 0; // "T" 대신 "0" 사용
    if (card.value === "A") return 1;
    return parseInt(card.value);
  }

  calculateHandValue(hand) {
    let value = 0;
    let calculation = [];

    for (let card of hand) {
      const cardValue = this.getCardValue(card);
      value = (value + cardValue) % 10;
      calculation.push(cardValue);
    }

    return {
      total: value,
      calculation: calculation.join(" + "),
      cards: hand,
    };
  }

  shouldBankerDraw(bankerScore, playerThirdCard) {
    if (bankerScore <= 2) return true;
    if (bankerScore >= 7) return false;
    if (!playerThirdCard) return bankerScore <= 5;

    const playerThirdValue = this.getCardValue(playerThirdCard);

    switch (bankerScore) {
      case 3:
        return playerThirdValue !== 8;
      case 4:
        return [2, 3, 4, 5, 6, 7].includes(playerThirdValue);
      case 5:
        return [4, 5, 6, 7].includes(playerThirdValue);
      case 6:
        return [6, 7].includes(playerThirdValue);
      default:
        return false;
    }
  }

  checkPairs(playerHand, bankerHand) {
    let playerPair = false;
    let bankerPair = false;

    if (playerHand.length >= 2) {
      const card1Value = this.getCardValue(playerHand[0]);
      const card2Value = this.getCardValue(playerHand[1]);
      playerPair = card1Value === card2Value;
    }

    if (bankerHand.length >= 2) {
      const card1Value = this.getCardValue(bankerHand[0]);
      const card2Value = this.getCardValue(bankerHand[1]);
      bankerPair = card1Value === card2Value;
    }

    return { playerPair, bankerPair };
  }

  playGame() {
    const playerHand = [];
    const bankerHand = [];

    // 초기 2장씩 배분
    playerHand.push(this.drawCard());
    bankerHand.push(this.drawCard());
    playerHand.push(this.drawCard());
    bankerHand.push(this.drawCard());

    const playerScore = this.calculateHandValue(playerHand);
    const bankerScore = this.calculateHandValue(bankerHand);

    // 내추럴 체크 (8 또는 9)
    if (playerScore.total >= 8 || bankerScore.total >= 8) {
      const { playerPair, bankerPair } = this.checkPairs(
        playerHand,
        bankerHand
      );
      return this.getGameResult(playerHand, bankerHand, playerPair, bankerPair);
    }

    // 플레이어 세 번째 카드 (5 이하일 때 받음)
    let playerThirdCard = null;
    if (playerScore.total <= 5) {
      playerThirdCard = this.drawCard();
      playerHand.push(playerThirdCard);
    }

    // 뱅커 세 번째 카드 (수정된 바카라 규칙 적용)
    const currentBankerScore = this.calculateHandValue(bankerHand);
    if (this.shouldBankerDraw(currentBankerScore.total, playerThirdCard)) {
      bankerHand.push(this.drawCard());
    }

    const { playerPair, bankerPair } = this.checkPairs(playerHand, bankerHand);
    return this.getGameResult(playerHand, bankerHand, playerPair, bankerPair);
  }

  getGameResult(playerHand, bankerHand, playerPair, bankerPair) {
    const finalPlayerScore = this.calculateHandValue(playerHand);
    const finalBankerScore = this.calculateHandValue(bankerHand);

    let result;
    if (finalPlayerScore.total > finalBankerScore.total) {
      result = "player";
    } else if (finalPlayerScore.total < finalBankerScore.total) {
      result = "banker";
    } else {
      result = "tie";
    }

    return {
      result,
      playerScore: finalPlayerScore.total,
      bankerScore: finalBankerScore.total,
      playerHand: finalPlayerScore,
      bankerHand: finalBankerScore,
      playerPairOccurred: playerPair,
      bankerPairOccurred: bankerPair,
      timestamp: new Date().toISOString(),
    };
  }

  getDeckInfo() {
    const remainingCards = this.deck.length;
    const remainingDecks = (remainingCards / 52).toFixed(1);
    return { remainingCards, remainingDecks };
  }
}

// 전역 게임 인스턴스 생성
const baccaratGame = new BaccaratGame();

// 카드 정보를 user.html로 전송하는 함수
function sendCardsToUserHtml(gameResult, callback) {
  // 카드 클리어 신호 전송
  io.emit("clear_cards_display_on_user_html");

  let delay = 800; // 시작 지연시간 증가 (300ms -> 800ms)
  let interval = 800; // 카드 간격 증가 (400ms -> 800ms)

  setTimeout(() => {
    // 플레이어 첫 번째 카드
    if (gameResult.playerHand.cards[0]) {
      io.emit("card_dealt_to_user_ui", {
        target: "player",
        cardValue: gameResult.playerHand.cards[0].value,
        cardSuit: gameResult.playerHand.cards[0].suit,
        cardIndex: 0,
        isNewHand: true,
      });
    }
  }, delay);

  setTimeout(() => {
    // 뱅커 첫 번째 카드
    if (gameResult.bankerHand.cards[0]) {
      io.emit("card_dealt_to_user_ui", {
        target: "banker",
        cardValue: gameResult.bankerHand.cards[0].value,
        cardSuit: gameResult.bankerHand.cards[0].suit,
        cardIndex: 0,
        isNewHand: true,
      });
    }
  }, delay + interval);

  setTimeout(() => {
    // 플레이어 두 번째 카드
    if (gameResult.playerHand.cards[1]) {
      io.emit("card_dealt_to_user_ui", {
        target: "player",
        cardValue: gameResult.playerHand.cards[1].value,
        cardSuit: gameResult.playerHand.cards[1].suit,
        cardIndex: 1,
        isNewHand: false,
      });
    }
  }, delay + interval * 2);

  setTimeout(() => {
    // 뱅커 두 번째 카드
    if (gameResult.bankerHand.cards[1]) {
      io.emit("card_dealt_to_user_ui", {
        target: "banker",
        cardValue: gameResult.bankerHand.cards[1].value,
        cardSuit: gameResult.bankerHand.cards[1].suit,
        cardIndex: 1,
        isNewHand: false,
      });
    }
  }, delay + interval * 3);

  // 세 번째 카드가 있는 경우
  setTimeout(() => {
    if (gameResult.playerHand.cards[2]) {
      io.emit("card_dealt_to_user_ui", {
        target: "player",
        cardValue: gameResult.playerHand.cards[2].value,
        cardSuit: gameResult.playerHand.cards[2].suit,
        cardIndex: 2,
        isNewHand: false,
      });
    }
  }, delay + interval * 4);

  setTimeout(() => {
    if (gameResult.bankerHand.cards[2]) {
      io.emit("card_dealt_to_user_ui", {
        target: "banker",
        cardValue: gameResult.bankerHand.cards[2].value,
        cardSuit: gameResult.bankerHand.cards[2].suit,
        cardIndex: 2,
        isNewHand: false,
      });
    }
  }, delay + interval * 5);

  // 모든 카드 전송 완료 후 콜백 실행
  // 더 여유있게 계산: 마지막 가능한 카드(6번째) + 추가 대기시간
  const totalWaitTime = delay + interval * 5 + 1000; // 1초 추가 대기
  setTimeout(() => {
    if (callback) {
      callback();
    }
  }, totalWaitTime);
}

// =====================
// Socket.io 설정 및 베팅 로직
// =====================
let currentBets = []; // 현재 베팅 내역 저장
let bettingActive = false; // 베팅 활성 상태
let bettingEndTime = null; // 베팅 종료 시간

// 사용자별 소켓 관리
const userSockets = new Map(); // <userId, socket>

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
  // 접속 시 현재 베팅 상태 전송
  socket.emit("betting_status", {
    active: bettingActive,
    endTime: bettingEndTime,
    stats: currentBettingStats,
  });

  // 베팅이 활성화되어 있으면 베팅 시작 이벤트도 전송
  if (bettingActive && bettingEndTime) {
    socket.emit("betting_started");
    socket.emit("betting_end_time", bettingEndTime);

    // 사용자가 이미 베팅한 내역이 있다면 전송 (소켓 인증 후에 처리)
    socket.on("request_my_bets", (token) => {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.id;

        const myCurrentBetsOnChoices = currentBets.reduce((acc, curBet) => {
          if (curBet.userId === userId) {
            acc[curBet.choice] = (acc[curBet.choice] || 0) + curBet.amount;
          }
          return acc;
        }, {});

        socket.emit("my_bets_updated", { myCurrentBetsOnChoices });
      } catch (err) {
        // 내 베팅 정보 요청 처리 실패
      }
    });
  }

  // 사용자 인증 및 소켓 등록
  socket.on("authenticate", (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;
      userSockets.set(userId, socket);
      socket.userId = userId;
    } catch (err) {
      // 소켓 인증 실패
    }
  });

  // 연결 해제 시 사용자 소켓 제거
  socket.on("disconnect", () => {
    if (socket.userId) {
      userSockets.delete(socket.userId);
    }
  });

  // 게임 상태 관리
  let gameState = {
    isBetting: false,
    endTime: null,
  };

  // 베팅 시작 이벤트 (관리자에 의해 호출됨)
  socket.on("start_betting", () => {
    const bettingDuration = 20; // 20초
    const endTime = new Date(Date.now() + bettingDuration * 1000);

    // 베팅 활성화
    bettingActive = true;
    bettingEndTime = endTime;

    // 모든 클라이언트에게 베팅 시작과 종료 시간 알림
    io.emit("betting_started");
    io.emit("betting_end_time", endTime);

    // 20초 후 베팅 종료
    setTimeout(() => {
      bettingActive = false;
      bettingEndTime = null;
      io.emit("betting_closed");
    }, bettingDuration * 1000);
  });

  // 관리자용 게임 시작 이벤트
  socket.on("admin_start_game", () => {
    // 게임 실행
    const gameResult = baccaratGame.playGame();

    // 현재 게임 결과 저장 (베팅 통계 포함)
    currentGameResult = {
      ...gameResult,
      stats: currentBettingStats,
      totalBets: currentBets.reduce((sum, bet) => sum + bet.amount, 0),
      playerCount: new Set(currentBets.map((bet) => bet.userId)).size,
    };

    // 카드 정보를 user.html로 전송하고, 완료 후 게임 결과 전송
    sendCardsToUserHtml(gameResult, () => {
      // 카드 전송 완료 후 게임 결과 전송

      // 모든 클라이언트에게 게임 결과 전송 (카드 정보 포함)
      io.emit("game_result_with_cards", {
        ...gameResult,
        deckInfo: baccaratGame.getDeckInfo(),
      });

      // 관리자에게만 game_result 이벤트 전송 (승인/거절 처리용)
      io.emit("game_result", {
        result: gameResult.result,
        playerScore: gameResult.playerScore,
        bankerScore: gameResult.bankerScore,
        playerPairOccurred: gameResult.playerPairOccurred,
        bankerPairOccurred: gameResult.bankerPairOccurred,
        timestamp: gameResult.timestamp,
      });
    });
  });

  // 덱 셔플 이벤트
  socket.on("admin_shuffle_deck", () => {
    baccaratGame.initializeDeck();
    baccaratGame.shuffleDeck();

    // 관리자에게 덱 정보 전송
    io.emit("deck_shuffled", {
      message: "덱이 셔플되었습니다",
      deckInfo: baccaratGame.getDeckInfo(),
    });
  });

  // 덱 정보 요청
  socket.on("get_deck_info", () => {
    socket.emit("deck_info", baccaratGame.getDeckInfo());
  });

  // 베팅 데이터 수신
  socket.on("place_bet", async (betData) => {
    const { choice, amount, token } = betData;

    if (!bettingActive) {
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

      if (user.balance < amount) {
        return socket.emit("error", "잔액이 부족합니다.");
      }

      // 즉시 잔액 차감
      user.balance -= amount;
      user.rollingWagered = (user.rollingWagered || 0) + amount;
      await user.save();

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

      socket.emit("bet_success", {
        message: "베팅이 완료되었습니다.",
        newBalance: user.balance,
      });

      // 해당 유저의 선택지별 총 베팅액 계산
      const myCurrentBetsOnChoices = currentBets.reduce((acc, curBet) => {
        if (curBet.userId === userId) {
          acc[curBet.choice] = (acc[curBet.choice] || 0) + curBet.amount;
        }
        return acc;
      }, {});
      socket.emit("my_bets_updated", { myCurrentBetsOnChoices });
    } catch (err) {
      socket.emit("error", "베팅 처리 중 오류가 발생했습니다.");
    }
  });

  socket.on("cancel_bet", async (data) => {
    const { token } = data; // 토큰만 받아도 사용자 식별 가능

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

      // 즉시 잔액 복원
      user.balance += betToCancel.amount;
      await user.save();

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
      io.emit("update_coins"); // 다른 유저에게도 (필요하다면) 잔액 업데이트 (여기서는 잔액 변화가 특정 유저에게만 해당)

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
    } catch (err) {
      socket.emit("error", "베팅 취소 처리 중 오류가 발생했습니다.");
    }
  });

  // 이 부분은 이제 admin_start_game에서 직접 처리하므로 제거합니다.
  // 중복된 game_result 이벤트 핸들러를 제거하여 결과 중복 발생을 방지합니다.

  let resultProcessing = false; // 결과 처리 중복 방지 플래그는 유지

  // 결과 승인 처리 수정
  socket.on("approve_result", async (approvedGameData) => {
    if (resultProcessing) {
      return;
    }
    resultProcessing = true;

    // 이제 즉시 잔액 처리를 하므로 별도의 flush 과정이 불필요

    try {
      // approvedGameData가 없거나, 필요한 result 필드가 없으면 오류 처리
      if (!approvedGameData || !approvedGameData.result) {
        // 기존의 currentGameResult를 사용하거나 오류 반환
        if (!currentGameResult) {
          throw new Error("승인할 게임 결과 데이터가 없습니다.");
        }
        // approvedGameData가 없을 경우, 기존의 currentGameResult를 사용 (페어 정보 X)
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
                winningsToAdd = bet.amount * 8; // 타이 당첨 (9배)
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

          // 롤링 포인트 적립 (베팅액만큼만)
          user.rollingWagered = (user.rollingWagered || 0) + bet.amount;

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

      // 관리자에게 결과 승인 완료 알림
      io.emit("admin_result_approved", {
        message: "게임 결과가 성공적으로 승인되어 모든 정산이 완료되었습니다.",
        gameResult: currentGameResult.result,
        timestamp: new Date(),
      });

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
        message: "게임 결과가 설정되고 사용자 잔액이 업데이트되었습니다.",
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

    io.emit("display_card_on_user_html", dataForUserHtml); // 모든 user.html 클라이언트에 브로드캐스트
  });

  socket.on("clear_cards_on_user_ui", () => {
    io.emit("clear_cards_display_on_user_html"); // user.html의 카드 표시 클리어 이벤트
  });

  // 베팅 상태 요청 (페이지 새로고침 시 현재 상태 복원용)
  socket.on("request_betting_status", () => {
    socket.emit("betting_status", {
      active: bettingActive,
      endTime: bettingEndTime,
      stats: currentBettingStats,
    });
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
  rollingPoint: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
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

    // 환전 가능 금액 계산: 베팅한 금액만큼 환전 가능
    const rollingWagered = user.rollingWagered || 0;
    const maxExchangeAmount = Math.min(user.balance, rollingWagered);

    if (amount > maxExchangeAmount) {
      return res.status(400).json({
        message: `환전 가능 금액을 초과했습니다. 최대 환전 가능: ${maxExchangeAmount.toLocaleString()}원`,
      });
    }

    // 새로운 수수료 계산 (환전액의 10%)
    const fee = Math.floor(amount * 0.1);
    const actualAmount = amount - fee;

    // 환전 요청 생성 (사용자 잔액/롤링은 관리자 승인 시 차감)
    const exchangeRequest = new ExchangeRequest({
      userId: user._id,
      username: user.username,
      requestAmount: amount,
      actualAmount: actualAmount,
      fee,
      rollingPoint: user.rollingWagered || 0,
    });
    await exchangeRequest.save();

    // 모든 관리자에게 새로운 환전 요청 알림
    io.emit("new_exchange_request", {
      username: user.username,
      requestAmount: amount,
      actualAmount: actualAmount,
      fee,
      createdAt: exchangeRequest.createdAt,
    });

    res.json({
      message: "환전 신청이 완료되었습니다. 관리자 승인을 기다려주세요.",
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

// 사용자의 충전 내역 조회 API 추가
app.get("/api/deposit/history", auth(), async (req, res) => {
  try {
    const deposits = await DepositRequest.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    res.json(deposits);
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// 사용자 상세 정보 조회 API (개선된 내 정보용)
app.get("/api/user/detailed-info", auth(), async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password").lean();
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    // 베팅 통계 계산
    const bettingHistory = user.bettingHistory || [];
    const wins = bettingHistory.filter((bet) => bet.result === "win").length;
    const losses = bettingHistory.filter((bet) => bet.result === "lose").length;
    const totalGames = bettingHistory.length;
    const winRate = totalGames > 0 ? ((wins / totalGames) * 100).toFixed(1) : 0;

    // 베팅 손익 계산
    let totalBetAmount = 0;
    let totalWinAmount = 0;
    let bettingProfit = 0;

    `사용자 ${user.username}의 베팅 기록 수:`, bettingHistory.length;

    bettingHistory.forEach((bet) => {
      totalBetAmount += bet.amount || 0;
      if (bet.result === "win") {
        const profit = calculateProfit(bet);
        totalWinAmount += (bet.amount || 0) + profit;
        bettingProfit += profit;
      } else if (bet.result === "lose") {
        bettingProfit -= bet.amount || 0;
      }
    });

    // 충전 내역 조회
    const deposits = await DepositRequest.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    const totalDeposited = deposits
      .filter((d) => d.status === "approved")
      .reduce((sum, d) => sum + (d.amount || 0), 0);

    // 환전 내역 조회
    const exchanges = await ExchangeRequest.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    const totalExchanged = exchanges
      .filter((e) => e.status === "approved")
      .reduce((sum, e) => sum + (e.actualAmount || 0), 0);

    // 전체 손익 계산 (현재 잔액 + 총 환전액 - 총 충전액)
    const overallProfit = user.balance + totalExchanged - totalDeposited;

    // 롤링 정보
    const rollingRequirement = (user.rollingDeposit || 0) * 1.5;
    const rollingWagered = user.rollingWagered || 0;
    const rollingProgress =
      rollingRequirement > 0
        ? Math.min(100, (rollingWagered / rollingRequirement) * 100)
        : 100;

    // 환전 가능 금액 계산: 베팅한 금액만큼 환전 가능
    const maxExchangeAmount = Math.min(user.balance, rollingWagered);

    // 최근 베팅 기록 (최근 20개)
    const recentBets = bettingHistory.slice(-20).reverse();

    // 베팅 선호도 분석
    const choiceStats = {
      player: bettingHistory.filter((bet) => bet.choice === "player").length,
      banker: bettingHistory.filter((bet) => bet.choice === "banker").length,
      tie: bettingHistory.filter((bet) => bet.choice === "tie").length,
      player_pair: bettingHistory.filter((bet) => bet.choice === "player_pair")
        .length,
      banker_pair: bettingHistory.filter((bet) => bet.choice === "banker_pair")
        .length,
    };

    const favoriteChoice = Object.entries(choiceStats).sort(
      ([, a], [, b]) => b - a
    )[0];

    res.json({
      // 기본 정보
      username: user.username,
      balance: user.balance,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      isApproved: user.isApproved,
      role: user.role,

      // 게임 통계
      gameStats: {
        totalGames,
        wins,
        losses,
        winRate: parseFloat(winRate),
        favoriteChoice: favoriteChoice
          ? {
              choice: favoriteChoice[0],
              count: favoriteChoice[1],
            }
          : null,
      },

      // 베팅 통계
      bettingStats: {
        totalBetAmount,
        totalWinAmount,
        bettingProfit,
        averageBetAmount:
          totalGames > 0 ? Math.round(totalBetAmount / totalGames) : 0,
      },

      // 재정 정보
      financialInfo: {
        totalDeposited,
        totalExchanged,
        overallProfit,
        depositCount: deposits.filter((d) => d.status === "approved").length,
        exchangeCount: exchanges.filter((e) => e.status === "approved").length,
      },

      // 롤링 정보
      rollingInfo: {
        rollingDeposit: user.rollingDeposit || 0,
        rollingWagered: rollingWagered,
        rollingRequirement,
        rollingProgress: parseFloat(rollingProgress.toFixed(1)),
        maxExchangeAmount,
      },

      // 최근 기록
      recentBets,
      recentDeposits: deposits.slice(0, 5),
      recentExchanges: exchanges.slice(0, 5),

      // 선호도 통계
      choiceStats,
    });
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

    const user = await User.findById(request.userId);
    if (!user) {
      // 사용자를 찾을 수 없으면 요청을 거절 처리
      request.status = "rejected";
      await request.save();
      return res
        .status(404)
        .json({ message: "사용자를 찾을 수 없어 요청을 거절 처리합니다." });
    }

    if (status === "approved") {
      if (user.balance < request.requestAmount) {
        return res.status(400).json({
          message: `사용자 잔액 부족. (현재 잔액: ${user.balance.toLocaleString()}원)`,
        });
      }

      // 잔액 차감 및 롤링 정산
      user.balance -= request.requestAmount;

      // 환전한 금액만큼 롤링 베팅액에서 차감
      user.rollingWagered = Math.max(
        0,
        (user.rollingWagered || 0) - request.requestAmount
      );

      await user.save();
    }

    // 'rejected'의 경우 사용자 잔액/롤링에 변경 없음

    request.status = status;
    await request.save();

    // 해당 유저에게 실시간 알림
    const userSocket = userSockets.get(user._id.toString());
    if (userSocket) {
      if (status === "approved") {
        userSocket.emit("balance_updated", { newBalance: user.balance });
        userSocket.emit("exchange_request_processed", {
          status: "approved",
          requestAmount: request.requestAmount,
          actualAmount: request.actualAmount,
          newBalance: user.balance,
        });
      } else {
        userSocket.emit("exchange_request_processed", {
          status: "rejected",
          requestAmount: request.requestAmount,
          actualAmount: request.actualAmount,
        });
      }
    }

    res.json({
      message: `환전 요청이 ${
        status === "approved" ? "승인" : "거절"
      }되었습니다.`,
    });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// 사용자 재정 요약 API (관리자용)
app.get(
  "/api/admin/users-financial-summary",
  auth("admin"),
  async (req, res) => {
    try {
      const users = await User.find().select("-password").lean();
      const depositsCollection =
        mongoose.connection.db.collection("depositrequests");
      const exchangeRequestsCollection =
        mongoose.connection.db.collection("exchangerequests");

      const summaries = [];

      for (const user of users) {
        const userIdStr = user._id.toString();

        // 총 충전액 계산
        const approvedDeposits = await depositsCollection
          .find({
            userId: new mongoose.Types.ObjectId(user._id), // ObjectId로 비교
            status: "approved",
          })
          .toArray();
        const totalDeposited = approvedDeposits.reduce(
          (sum, dep) => sum + (dep.amount || 0),
          0
        );

        // 총 환전액 계산
        const approvedExchanges = await exchangeRequestsCollection
          .find({
            userId: new mongoose.Types.ObjectId(user._id), // ObjectId로 비교
            status: "approved",
          })
          .toArray();
        const totalExchanged = approvedExchanges.reduce(
          (sum, ex) => sum + (ex.actualAmount || 0),
          0
        );

        const financialProfit = user.balance + totalExchanged - totalDeposited;

        summaries.push({
          username: user.username,
          userId: user._id,
          currentBalance: user.balance,
          totalDeposited,
          totalExchanged,
          financialProfit,
          isApproved: user.isApproved,
          role: user.role,
        });
      }

      // 순손익이 높은 순으로 정렬
      summaries.sort((a, b) => b.financialProfit - a.financialProfit);

      res.json(summaries);
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  }
);

// 충전 요청 스키마 추가
const depositRequestSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  username: String,
  amount: Number,
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const DepositRequest = mongoose.model("DepositRequest", depositRequestSchema);

// 충전 신청 API
app.post("/api/deposit/request", auth(), async (req, res) => {
  const { amount } = req.body;
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }
    if (amount < 10000) {
      return res
        .status(400)
        .json({ message: "최소 10,000원부터 충전 가능합니다." });
    }

    const depositRequest = new DepositRequest({
      userId: user._id,
      username: user.username,
      amount: amount,
    });
    await depositRequest.save();

    // 모든 관리자에게 새로운 충전 요청 알림
    io.emit("new_deposit_request", {
      username: user.username,
      amount: amount,
      createdAt: depositRequest.createdAt,
    });

    res.json({
      message: "충전 요청이 완료되었습니다. 관리자 승인을 기다려주세요.",
    });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// 관리자용 충전 요청 목록 조회 API
app.get("/api/admin/deposit-requests", auth("admin"), async (req, res) => {
  try {
    const requests = await DepositRequest.find().sort({ createdAt: -1 }).lean();
    res.json(requests);
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// 관리자용 충전 요청 처리 API
app.put("/api/admin/deposit-requests/:id", auth("admin"), async (req, res) => {
  const { status } = req.body;
  try {
    const request = await DepositRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ message: "요청을 찾을 수 없습니다." });
    }
    if (request.status !== "pending") {
      return res.status(400).json({ message: "이미 처리된 요청입니다." });
    }

    const user = await User.findById(request.userId);
    if (!user) {
      // 사용자를 찾을 수 없으면 요청을 거절 처리
      request.status = "rejected";
      await request.save();
      return res
        .status(404)
        .json({ message: "사용자를 찾을 수 없어 요청을 거절 처리합니다." });
    }

    request.status = status;
    await request.save();

    if (status === "approved") {
      // 잔액 증가 및 롤링 포인트 추가
      user.balance += request.amount;
      user.rollingDeposit = (user.rollingDeposit || 0) + request.amount;
      await user.save();

      // 해당 유저에게 실시간 잔액 업데이트 및 충전 승인 알림
      const userSocket = userSockets.get(user._id.toString());
      if (userSocket) {
        userSocket.emit("balance_updated", { newBalance: user.balance });
        userSocket.emit("deposit_request_processed", {
          status: "approved",
          amount: request.amount,
          newBalance: user.balance,
        });
      }

      // 모든 관리자에게 사용자 잔액 업데이트 알림
      io.emit("user_balance_updated", {
        userId: user._id.toString(),
        newBalance: user.balance,
      });
    } else {
      // 거절된 경우에도 사용자에게 알림
      const userSocket = userSockets.get(user._id.toString());
      if (userSocket) {
        userSocket.emit("deposit_request_processed", {
          status: "rejected",
          amount: request.amount,
        });
      }
    }

    res.json({
      message: `충전 요청이 ${
        status === "approved" ? "승인" : "거절"
      }되었습니다.`,
    });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================
// 뽀찌(머니 전송) 기능
// =====================

// 송금 스키마
const transferSchema = new mongoose.Schema({
  fromUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  toUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  fee: {
    type: Number,
    required: true,
  },
  type: {
    type: String,
    enum: ["sent", "received"],
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Transfer = mongoose.model("Transfer", transferSchema);

// 머니 요청 스키마
const moneyRequestSchema = new mongoose.Schema({
  fromUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  toUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  message: {
    type: String,
    default: "",
  },
  status: {
    type: String,
    enum: ["pending", "accepted", "rejected"],
    default: "pending",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const MoneyRequest = mongoose.model("MoneyRequest", moneyRequestSchema);

// 사용자 목록 조회 API (자신 제외)
app.get("/api/users/list", auth(), async (req, res) => {
  try {
    const users = await User.find({
      _id: { $ne: req.user.id }, // 자신 제외
      isApproved: true, // 승인된 사용자만
    })
      .select("username _id")
      .sort({ username: 1 });

    res.json(users);
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// 송금 API
app.post("/api/transfer/send", auth(), async (req, res) => {
  const { toUserId, amount } = req.body;

  try {
    if (!toUserId || !amount || amount < 1000) {
      return res
        .status(400)
        .json({ message: "올바른 송금 정보를 입력해주세요. (최소 1,000원)" });
    }

    const fromUser = await User.findById(req.user.id);
    const toUser = await User.findById(toUserId);

    if (!fromUser || !toUser) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    if (fromUser._id.toString() === toUser._id.toString()) {
      return res
        .status(400)
        .json({ message: "자기 자신에게 송금할 수 없습니다." });
    }

    const fee = Math.floor(amount * 0.05); // 5% 수수료
    const totalAmount = amount + fee;

    if (fromUser.balance < totalAmount) {
      return res.status(400).json({ message: "잔액이 부족합니다." });
    }

    // 송금 처리
    fromUser.balance -= totalAmount;
    toUser.balance += amount;

    await fromUser.save();
    await toUser.save();

    // 송금 기록 생성 (보낸 사람)
    const sentTransfer = new Transfer({
      fromUserId: fromUser._id,
      toUserId: toUser._id,
      amount,
      fee,
      type: "sent",
    });
    await sentTransfer.save();

    // 송금 기록 생성 (받은 사람) - 수수료 없음
    const receivedTransfer = new Transfer({
      fromUserId: fromUser._id,
      toUserId: toUser._id,
      amount,
      fee: 0,
      type: "received",
    });
    await receivedTransfer.save();

    // 받는 사람에게 실시간 알림
    const toUserSocket = userSockets.get(toUser._id.toString());
    if (toUserSocket) {
      toUserSocket.emit("money_received", {
        fromUserId: fromUser._id.toString(),
        fromUsername: fromUser.username,
        amount,
        timestamp: new Date(),
      });
      toUserSocket.emit("balance_updated", {
        newBalance: toUser.balance,
      });
      // 송금 내역 새로고침 신호
      toUserSocket.emit("transfer_history_updated");
    }

    // 보낸 사람에게도 송금 완료 알림
    const fromUserSocket = userSockets.get(fromUser._id.toString());
    if (fromUserSocket) {
      fromUserSocket.emit("money_sent", {
        toUserId: toUser._id.toString(),
        toUsername: toUser.username,
        amount,
        fee,
        timestamp: new Date(),
      });
      // 송금 내역 새로고침 신호
      fromUserSocket.emit("transfer_history_updated");
    }

    res.json({
      message: "송금이 완료되었습니다.",
      newBalance: fromUser.balance,
    });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// 머니 요청 API
app.post("/api/transfer/request", auth(), async (req, res) => {
  const { fromUserId, amount, message } = req.body;

  try {
    if (!fromUserId || !amount || amount < 1000) {
      return res
        .status(400)
        .json({ message: "올바른 요청 정보를 입력해주세요. (최소 1,000원)" });
    }

    const toUser = await User.findById(req.user.id); // 요청하는 사람
    const fromUser = await User.findById(fromUserId); // 요청받는 사람

    if (!toUser || !fromUser) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    if (toUser._id.toString() === fromUser._id.toString()) {
      return res
        .status(400)
        .json({ message: "자기 자신에게 요청할 수 없습니다." });
    }

    // 머니 요청 생성
    const moneyRequest = new MoneyRequest({
      fromUserId: req.user.id, // 요청하는 사람
      toUserId: fromUserId, // 요청받는 사람
      amount,
      message: message || "",
    });
    await moneyRequest.save();

    // 요청받는 사람에게 실시간 알림
    const fromUserSocket = userSockets.get(fromUser._id.toString());
    if (fromUserSocket) {
      fromUserSocket.emit("money_request_received", {
        requestId: moneyRequest._id.toString(),
        fromUserId: toUser._id.toString(),
        fromUsername: toUser.username,
        amount,
        message: message || "",
        timestamp: new Date(),
      });
      // 받은 요청 목록 새로고침 신호
      fromUserSocket.emit("received_requests_updated");
    }

    // 요청한 사람에게도 요청 전송 완료 알림
    const toUserSocket = userSockets.get(toUser._id.toString());
    if (toUserSocket) {
      toUserSocket.emit("money_request_sent", {
        requestId: moneyRequest._id.toString(),
        toUserId: fromUser._id.toString(),
        toUsername: fromUser.username,
        amount,
        message: message || "",
        timestamp: new Date(),
      });
    }

    res.json({ message: "머니 요청이 전송되었습니다." });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// 받은 요청 목록 조회 API
app.get("/api/transfer/requests/received", auth(), async (req, res) => {
  try {
    const requests = await MoneyRequest.find({
      toUserId: req.user.id,
      status: "pending",
    })
      .populate("fromUserId", "username")
      .sort({ createdAt: -1 })
      .lean();

    const formattedRequests = requests.map((req) => ({
      _id: req._id,
      fromUser: {
        _id: req.fromUserId._id,
        username: req.fromUserId.username,
      },
      amount: req.amount,
      message: req.message,
      status: req.status,
      createdAt: req.createdAt,
    }));

    res.json(formattedRequests);
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// 요청 수락 API
app.post(
  "/api/transfer/request/:requestId/accept",
  auth(),
  async (req, res) => {
    try {
      const request = await MoneyRequest.findById(
        req.params.requestId
      ).populate("fromUserId", "username");

      if (!request) {
        return res.status(404).json({ message: "요청을 찾을 수 없습니다." });
      }

      if (request.toUserId.toString() !== req.user.id) {
        return res.status(403).json({ message: "권한이 없습니다." });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ message: "이미 처리된 요청입니다." });
      }

      const fromUser = await User.findById(request.toUserId); // 송금하는 사람 (요청받은 사람)
      const toUser = await User.findById(request.fromUserId); // 받는 사람 (요청한 사람)

      if (!fromUser || !toUser) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }

      const fee = Math.floor(request.amount * 0.05); // 5% 수수료
      const totalAmount = request.amount + fee;

      if (fromUser.balance < totalAmount) {
        return res.status(400).json({ message: "잔액이 부족합니다." });
      }

      // 송금 처리
      fromUser.balance -= totalAmount;
      toUser.balance += request.amount;

      await fromUser.save();
      await toUser.save();

      // 요청 상태 업데이트
      request.status = "accepted";
      await request.save();

      // 송금 기록 생성
      const sentTransfer = new Transfer({
        fromUserId: fromUser._id,
        toUserId: toUser._id,
        amount: request.amount,
        fee,
        type: "sent",
      });
      await sentTransfer.save();

      const receivedTransfer = new Transfer({
        fromUserId: fromUser._id,
        toUserId: toUser._id,
        amount: request.amount,
        fee: 0,
        type: "received",
      });
      await receivedTransfer.save();

      // 요청한 사람에게 실시간 알림
      const toUserSocket = userSockets.get(toUser._id.toString());
      if (toUserSocket) {
        toUserSocket.emit("money_request_accepted", {
          requestId: request._id.toString(),
          acceptedByUserId: fromUser._id.toString(),
          acceptedByUsername: fromUser.username,
          amount: request.amount,
          timestamp: new Date(),
        });
        toUserSocket.emit("balance_updated", {
          newBalance: toUser.balance,
        });
        // 송금 내역 새로고침 신호
        toUserSocket.emit("transfer_history_updated");
      }

      // 수락한 사람에게도 알림
      const fromUserSocket = userSockets.get(fromUser._id.toString());
      if (fromUserSocket) {
        fromUserSocket.emit("money_request_accept_completed", {
          requestId: request._id.toString(),
          toUserId: toUser._id.toString(),
          toUsername: toUser.username,
          amount: request.amount,
          fee,
          timestamp: new Date(),
        });
        // 송금 내역 및 받은 요청 목록 새로고침 신호
        fromUserSocket.emit("transfer_history_updated");
        fromUserSocket.emit("received_requests_updated");
      }

      res.json({
        message: "요청을 수락했습니다.",
        newBalance: fromUser.balance,
      });
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  }
);

// 요청 거절 API
app.post(
  "/api/transfer/request/:requestId/reject",
  auth(),
  async (req, res) => {
    try {
      const request = await MoneyRequest.findById(
        req.params.requestId
      ).populate("toUserId", "username");

      if (!request) {
        return res.status(404).json({ message: "요청을 찾을 수 없습니다." });
      }

      if (request.toUserId._id.toString() !== req.user.id) {
        return res.status(403).json({ message: "권한이 없습니다." });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ message: "이미 처리된 요청입니다." });
      }

      // 요청 상태 업데이트
      request.status = "rejected";
      await request.save();

      // 요청한 사람에게 실시간 알림
      const fromUser = await User.findById(request.fromUserId);
      const fromUserSocket = userSockets.get(request.fromUserId.toString());
      if (fromUserSocket) {
        fromUserSocket.emit("money_request_rejected", {
          requestId: request._id.toString(),
          rejectedByUserId: request.toUserId._id.toString(),
          rejectedByUsername: request.toUserId.username,
          amount: request.amount,
          message: request.message,
          timestamp: new Date(),
        });
      }

      // 거절한 사람에게도 알림
      const toUserSocket = userSockets.get(req.user.id);
      if (toUserSocket) {
        toUserSocket.emit("money_request_reject_completed", {
          requestId: request._id.toString(),
          fromUserId: request.fromUserId.toString(),
          fromUsername: fromUser.username,
          amount: request.amount,
          timestamp: new Date(),
        });
        // 받은 요청 목록 새로고침 신호
        toUserSocket.emit("received_requests_updated");
      }

      res.json({ message: "요청을 거절했습니다." });
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  }
);

// 송금 내역 조회 API
app.get("/api/transfer/history", auth(), async (req, res) => {
  try {
    const transfers = await Transfer.find({
      $or: [{ fromUserId: req.user.id }, { toUserId: req.user.id }],
    })
      .populate("fromUserId", "username")
      .populate("toUserId", "username")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const formattedTransfers = transfers.map((transfer) => {
      const isSent = transfer.fromUserId._id.toString() === req.user.id;
      return {
        _id: transfer._id,
        type: isSent ? "sent" : "received",
        fromUser: {
          _id: transfer.fromUserId._id,
          username: transfer.fromUserId.username,
        },
        toUser: {
          _id: transfer.toUserId._id,
          username: transfer.toUserId.username,
        },
        amount: transfer.amount,
        fee: isSent ? transfer.fee : 0,
        createdAt: transfer.createdAt,
      };
    });

    res.json(formattedTransfers);
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================
// 서버 시작
// =====================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {});
