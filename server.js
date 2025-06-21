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
const FRONTEND_URL = process.env.FRONTEND_URL || "https://goldbac.netlify.app";

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
    default: 0,
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
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" }); // 30일로 연장

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

    // 환전 가능 금액 계산: 롤링 요구량 달성 시에만 환전 가능
    const rollingDeposit = user.rollingDeposit || 0;
    const rollingWagered = user.rollingWagered || 0;
    const rollingRequirement = rollingDeposit * 1.0;

    // 롤링 요구량을 달성한 경우에만 환전 가능
    const maxExchangeAmount =
      rollingWagered >= rollingRequirement ? user.balance : 0;

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

// 관리자용 사용자 상세 정보 조회 API
app.get("/api/admin/user-detail/:userId", auth("admin"), async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)
      .select("-password")
      .lean();
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
    const deposits = await DepositRequest.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .lean();

    const totalDeposited = deposits
      .filter((d) => d.status === "approved")
      .reduce((sum, d) => sum + (d.amount || 0), 0);

    // 환전 내역 조회
    const exchanges = await ExchangeRequest.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .lean();

    const totalExchanged = exchanges
      .filter((e) => e.status === "approved")
      .reduce((sum, e) => sum + (e.actualAmount || 0), 0);

    // 전체 손익 계산 (현재 잔액 + 총 환전액 - 총 충전액)
    const overallProfit = user.balance + totalExchanged - totalDeposited;

    // 롤링 정보 (실제 서버 데이터)
    const rollingDeposit = user.rollingDeposit || 0;
    const rollingWagered = user.rollingWagered || 0;
    const rollingRequirement = rollingDeposit * 1.0;
    const rollingProgress =
      rollingRequirement > 0
        ? Math.min(100, (rollingWagered / rollingRequirement) * 100)
        : 100;

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
      _id: user._id,
      username: user.username,
      balance: user.balance,
      role: user.role,
      isApproved: user.isApproved,
      createdAt: user.createdAt,

      // 게임 통계
      wins,
      losses,
      totalGames,
      winRate: parseFloat(winRate),
      favoriteChoice: favoriteChoice
        ? {
            choice: favoriteChoice[0],
            count: favoriteChoice[1],
          }
        : null,

      // 베팅 통계 (실제 베팅액 100%)
      totalBetAmount,
      totalWinAmount,
      bettingProfit,
      averageBetAmount:
        totalGames > 0 ? Math.round(totalBetAmount / totalGames) : 0,

      // 재정 정보
      totalDeposited,
      totalExchanged,
      overallProfit,
      depositCount: deposits.filter((d) => d.status === "approved").length,
      exchangeCount: exchanges.filter((e) => e.status === "approved").length,

      // 롤링 정보 (실제 서버 데이터)
      rollingDeposit,
      rollingWagered,
      rollingRequirement,
      rollingProgress: parseFloat(rollingProgress.toFixed(1)),

      // 베팅 선호도
      choiceStats,

      // 최근 거래 내역
      recentTransactions: [
        ...deposits.slice(0, 5).map((d) => ({
          type: "deposit",
          amount: d.amount,
          status: d.status,
          createdAt: d.createdAt,
        })),
        ...exchanges.slice(0, 5).map((e) => ({
          type: "exchange",
          amount: e.actualAmount || e.requestAmount,
          status: e.status,
          createdAt: e.createdAt,
        })),
      ]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10),
    });
  } catch (err) {
    console.error("Error fetching user detail:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// 리더보드 데이터 생성 함수
async function generateLeaderboardData() {
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

    return leaderboard;
  } catch (err) {
    console.error("리더보드 데이터 생성 오류:", err);
    return [];
  }
}

// 리더보드 업데이트 및 브로드캐스트 함수
async function updateAndBroadcastLeaderboard() {
  try {
    const leaderboard = await generateLeaderboardData();
    // 모든 관리자에게 리더보드 업데이트 전송
    io.emit("leaderboard_updated", leaderboard);
  } catch (err) {
    console.error("리더보드 브로드캐스트 오류:", err);
  }
}

// 리더보드 API 수정
app.get("/api/admin/leaderboard", auth("admin"), async (req, res) => {
  try {
    const leaderboard = await generateLeaderboardData();
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

      // 리더보드 업데이트를 위한 새로운 리더보드 데이터 전송
      await updateAndBroadcastLeaderboard();

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
        return bet.amount * 8; // 타이 승리: 베팅액 8배 수익 (총 9배 지급)
      } else if (bet.choice === "player_pair" || bet.choice === "banker_pair") {
        return bet.amount * 11; // 페어 승리: 베팅액 11배 수익 (총 12배 지급)
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
      // 실제 카드 랭크 비교 (바카라 점수가 아닌 카드 자체의 value)
      const card1Rank = playerHand[0].value;
      const card2Rank = playerHand[1].value;
      playerPair = card1Rank === card2Rank;
    }

    if (bankerHand.length >= 2) {
      // 실제 카드 랭크 비교 (바카라 점수가 아닌 카드 자체의 value)
      const card1Rank = bankerHand[0].value;
      const card2Rank = bankerHand[1].value;
      bankerPair = card1Rank === card2Rank;
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

  // 승부 조작을 위한 특정 결과 생성 메서드
  playFixedGame(fixedResult) {
    const playerHand = [];
    const bankerHand = [];

    // 패턴 번호 추출 (예: "player_1", "banker_2", "tie_3")
    const [result, patternNum] = fixedResult.split("_");
    const pattern = parseInt(patternNum) || 1;

    // 원하는 결과에 따라 미리 계산된 카드 조합 사용
    if (result === "player") {
      this.setPlayerWinPattern(playerHand, bankerHand, pattern);
    } else if (result === "banker") {
      this.setBankerWinPattern(playerHand, bankerHand, pattern);
    } else if (result === "tie") {
      this.setTiePattern(playerHand, bankerHand, pattern);
    }

    const { playerPair, bankerPair } = this.checkPairs(playerHand, bankerHand);
    return this.getGameResult(playerHand, bankerHand, playerPair, bankerPair);
  }

  // 플레이어 승리 패턴들
  setPlayerWinPattern(playerHand, bankerHand, pattern) {
    switch (pattern) {
      case 1: // 내추럴 9 vs 8
        playerHand.push({ suit: "H", value: "9", id: "9H_p1" });
        playerHand.push({ suit: "D", value: "0", id: "0D_p1" });
        bankerHand.push({ suit: "C", value: "8", id: "8C_p1" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_p1" });
        break;
      case 2: // 세 번째 카드로 역전승
        playerHand.push({ suit: "H", value: "4", id: "4H_p2" });
        playerHand.push({ suit: "D", value: "2", id: "2D_p2" });
        playerHand.push({ suit: "S", value: "3", id: "3S_p2" }); // 6+3=9
        bankerHand.push({ suit: "C", value: "5", id: "5C_p2" });
        bankerHand.push({ suit: "H", value: "2", id: "2H_p2" }); // 7로 스탠드
        break;
      case 3: // 간발의 차이로 승리
        playerHand.push({ suit: "H", value: "6", id: "6H_p3" });
        playerHand.push({ suit: "D", value: "2", id: "2D_p3" }); // 8
        bankerHand.push({ suit: "C", value: "4", id: "4C_p3" });
        bankerHand.push({ suit: "S", value: "3", id: "3S_p3" }); // 7
        break;
      case 4: // 드라마틱 역전 (낮은 점수에서 세 번째 카드로 9)
        playerHand.push({ suit: "H", value: "A", id: "AH_p4" });
        playerHand.push({ suit: "D", value: "2", id: "2D_p4" }); // 3
        playerHand.push({ suit: "S", value: "6", id: "6S_p4" }); // 3+6=9
        bankerHand.push({ suit: "C", value: "3", id: "3C_p4" });
        bankerHand.push({ suit: "H", value: "4", id: "4H_p4" }); // 7
        bankerHand.push({ suit: "D", value: "A", id: "AD_p4" }); // 7+1=8 (플레이어 6이므로 뱅커 드로우)
        break;
      case 5: // 페어가 있는 승부
        playerHand.push({ suit: "H", value: "7", id: "7H_p5" });
        playerHand.push({ suit: "D", value: "7", id: "7D_p5" }); // 4 (페어)
        playerHand.push({ suit: "S", value: "5", id: "5S_p5" }); // 4+5=9
        bankerHand.push({ suit: "C", value: "6", id: "6C_p5" });
        bankerHand.push({ suit: "H", value: "2", id: "2H_p5" }); // 8
        break;
      case 6: // 미라클 승부 (0에서 9로)
        playerHand.push({ suit: "H", value: "K", id: "KH_p6" });
        playerHand.push({ suit: "D", value: "Q", id: "QD_p6" }); // 0
        playerHand.push({ suit: "S", value: "9", id: "9S_p6" }); // 0+9=9
        bankerHand.push({ suit: "C", value: "4", id: "4C_p6" });
        bankerHand.push({ suit: "H", value: "4", id: "4H_p6" }); // 8
        break;
      default:
        // 기본 패턴
        playerHand.push({ suit: "H", value: "9", id: "9H_default" });
        playerHand.push({ suit: "D", value: "0", id: "0D_default" });
        bankerHand.push({ suit: "C", value: "8", id: "8C_default" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_default" });
    }
  }

  // 뱅커 승리 패턴들
  setBankerWinPattern(playerHand, bankerHand, pattern) {
    switch (pattern) {
      case 1: // 내추럴 9 vs 8
        playerHand.push({ suit: "H", value: "8", id: "8H_b1" });
        playerHand.push({ suit: "D", value: "0", id: "0D_b1" });
        bankerHand.push({ suit: "C", value: "9", id: "9C_b1" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_b1" });
        break;
      case 2: // 뱅커 룰에 의한 승리 (정상적인 드로우)
        playerHand.push({ suit: "H", value: "2", id: "2H_b2" });
        playerHand.push({ suit: "D", value: "A", id: "AD_b2" }); // 3
        playerHand.push({ suit: "S", value: "4", id: "4S_b2" }); // 3+4=7
        bankerHand.push({ suit: "C", value: "2", id: "2C_b2" });
        bankerHand.push({ suit: "H", value: "6", id: "6H_b2" }); // 8
        // 플레이어 세 번째 카드가 4이므로 뱅커는 스탠드
        break;
      case 3: // 압도적 승리
        playerHand.push({ suit: "H", value: "2", id: "2H_b3" });
        playerHand.push({ suit: "D", value: "3", id: "3D_b3" }); // 5
        bankerHand.push({ suit: "C", value: "7", id: "7C_b3" });
        bankerHand.push({ suit: "S", value: "2", id: "2S_b3" }); // 9
        break;
      case 4: // 뱅커 룰에 의한 드로우 승부
        playerHand.push({ suit: "H", value: "2", id: "2H_b4" });
        playerHand.push({ suit: "D", value: "A", id: "AD_b4" }); // 3
        playerHand.push({ suit: "S", value: "4", id: "4S_b4" }); // 3+4=7
        bankerHand.push({ suit: "C", value: "A", id: "AC_b4" });
        bankerHand.push({ suit: "H", value: "2", id: "2H_b4" }); // 3
        bankerHand.push({ suit: "D", value: "5", id: "5D_b4" }); // 3+5=8
        break;
      case 5: // 내추럴 8 승부 (페어 없음)
        playerHand.push({ suit: "H", value: "3", id: "3H_b5" });
        playerHand.push({ suit: "D", value: "3", id: "3D_b5" }); // 6 (페어)
        bankerHand.push({ suit: "C", value: "8", id: "8C_b5" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_b5" }); // 8 (내추럴, 스탠드)
        break;
      case 6: // 극적인 세 번째 카드 승부
        playerHand.push({ suit: "H", value: "A", id: "AH_b6" });
        playerHand.push({ suit: "D", value: "A", id: "AD_b6" }); // 2
        playerHand.push({ suit: "S", value: "5", id: "5S_b6" }); // 2+5=7
        bankerHand.push({ suit: "C", value: "2", id: "2C_b6" });
        bankerHand.push({ suit: "H", value: "4", id: "4H_b6" }); // 6
        bankerHand.push({ suit: "D", value: "2", id: "2D_b6" }); // 6+2=8
        break;
      default:
        // 기본 패턴
        playerHand.push({ suit: "H", value: "7", id: "7H_default" });
        playerHand.push({ suit: "D", value: "0", id: "0D_default" });
        bankerHand.push({ suit: "C", value: "9", id: "9C_default" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_default" });
    }
  }

  // 타이 패턴들
  setTiePattern(playerHand, bankerHand, pattern) {
    switch (pattern) {
      case 1: // 내추럴 8 타이
        playerHand.push({ suit: "H", value: "8", id: "8H_t1" });
        playerHand.push({ suit: "D", value: "0", id: "0D_t1" });
        bankerHand.push({ suit: "C", value: "8", id: "8C_t1" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_t1" });
        break;
      case 2: // 세 번째 카드 후 타이
        playerHand.push({ suit: "H", value: "2", id: "2H_t2" });
        playerHand.push({ suit: "D", value: "4", id: "4D_t2" });
        playerHand.push({ suit: "S", value: "A", id: "AS_t2" }); // 6+1=7
        bankerHand.push({ suit: "C", value: "5", id: "5C_t2" });
        bankerHand.push({ suit: "H", value: "A", id: "AH_t2" });
        bankerHand.push({ suit: "D", value: "A", id: "AD_t2" }); // 6+1=7
        break;
      case 3: // 낮은 점수 타이
        playerHand.push({ suit: "H", value: "3", id: "3H_t3" });
        playerHand.push({ suit: "D", value: "0", id: "0D_t3" }); // 3
        bankerHand.push({ suit: "C", value: "2", id: "2C_t3" });
        bankerHand.push({ suit: "S", value: "A", id: "AS_t3" }); // 3
        break;
      case 4: // 내추럴 9 타이 (드문 경우)
        playerHand.push({ suit: "H", value: "9", id: "9H_t4" });
        playerHand.push({ suit: "D", value: "0", id: "0D_t4" });
        bankerHand.push({ suit: "C", value: "9", id: "9C_t4" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_t4" });
        break;
      case 5: // 페어 타이 (둘 다 페어)
        playerHand.push({ suit: "H", value: "5", id: "5H_t5" });
        playerHand.push({ suit: "D", value: "5", id: "5D_t5" }); // 0 (페어)
        bankerHand.push({ suit: "C", value: "K", id: "KC_t5" });
        bankerHand.push({ suit: "S", value: "Q", id: "QS_t5" }); // 0 (둘 다 0)
        break;
      case 6: // 복잡한 세 번째 카드 타이
        playerHand.push({ suit: "H", value: "A", id: "AH_t6" });
        playerHand.push({ suit: "D", value: "3", id: "3D_t6" }); // 4
        playerHand.push({ suit: "S", value: "2", id: "2S_t6" }); // 4+2=6
        bankerHand.push({ suit: "C", value: "2", id: "2C_t6" });
        bankerHand.push({ suit: "H", value: "2", id: "2H_t6" }); // 4
        bankerHand.push({ suit: "D", value: "2", id: "2D_t6" }); // 4+2=6
        break;
      default:
        // 기본 패턴
        playerHand.push({ suit: "H", value: "8", id: "8H_default" });
        playerHand.push({ suit: "D", value: "0", id: "0D_default" });
        bankerHand.push({ suit: "C", value: "8", id: "8C_default" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_default" });
    }
  }
}

// 전역 게임 인스턴스 생성
const baccaratGame = new BaccaratGame();

// 승부 조작 관련 변수
let fixedGameResult = null; // 조작된 게임 결과 저장

// 카드 정보를 user.html로 전송하는 함수
function sendCardsToUserHtml(gameResult, callback) {
  // 카드 클리어 신호 전송
  io.emit("clear_cards_display_on_user_html");

  let delay = 1000; // 시작 지연시간 증가 (800ms -> 1000ms)
  let interval = 1000; // 카드 간격 증가 (800ms -> 1000ms)

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
  const totalWaitTime = delay + interval * 5 + 1500; // 1.5초 추가 대기
  setTimeout(() => {
    if (callback) {
      callback();
    }
  }, totalWaitTime);
}

// =====================
// Socket.io 설정 및 베팅 로직
// =====================
let currentBets = []; // 현재 베팅 내역 저장 (일괄 처리용)
let tempBets = new Map(); // 임시 베팅 저장 (userId -> { player: 50000, banker_pair: 10000, ... })
let bettingActive = false; // 베팅 활성 상태
let bettingEndTime = null; // 베팅 종료 시간

// 사용자별 소켓 관리
const userSockets = new Map(); // <userId, socket>

// 성능 모니터링을 위한 변수들
let maxConcurrentUsers = 0;
let totalBetsProcessed = 0;

// 사용자 정보 캐시 (메모리 최적화)
const userCache = new Map(); // <userId, userInfo>
const CACHE_TTL = 5 * 60 * 1000; // 5분 캐시

// 캐시 정리 함수
const cleanUserCache = () => {
  const now = Date.now();
  for (const [userId, data] of userCache.entries()) {
    if (data.cachedAt && now - data.cachedAt > CACHE_TTL) {
      userCache.delete(userId);
    }
  }
};

// 5분마다 캐시 정리
setInterval(cleanUserCache, CACHE_TTL);

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
let resultProcessing = false;

// 통합 자동 게임 상태 (자동시작 + 백그라운드 통합)
let autoGameState = {
  isActive: false,
  gameCount: 0,
  maxGames: 0, // 0이면 무제한 (계속)
  gameTimer: null,
  bettingTimer: null,
  adminSocketId: null, // 자동 게임 시작한 admin 소켓 ID
};

// 임시 베팅을 실제 베팅으로 변환하는 함수
async function processTempBetsToReal() {
  try {
    // 임시 베팅을 실제 베팅 배열로 변환
    currentBets = [];

    for (const [userId, userData] of tempBets.entries()) {
      const user = await User.findById(userId);
      if (!user) {
        continue;
      }

      // 사용자별 총 베팅 금액 계산
      const totalBetAmount = userData.totalAmount;

      // 잔액 체크
      if (user.balance < totalBetAmount) {
        continue;
      }

      // 실제 잔액 차감 및 롤링 업데이트
      user.balance -= totalBetAmount;
      user.rollingWagered = (user.rollingWagered || 0) + totalBetAmount;
      await user.save();

      // 각 선택지별 총액을 실제 베팅으로 변환
      for (const [choice, amount] of Object.entries(userData.bets)) {
        if (amount > 0) {
          currentBets.push({
            userId: userId,
            choice: choice,
            amount: amount,
            username: userData.username,
          });
        }
      }

      // 사용자에게 실제 잔액 업데이트 알림
      const userSocket = userSockets.get(userId);
      if (userSocket) {
        userSocket.emit("balance_updated", {
          newBalance: user.balance,
        });
      }
    }

    // 임시 베팅 초기화
    tempBets.clear();

    // 모든 클라이언트에게 베팅 확정 알림
    io.emit("bets_confirmed", {
      message: "베팅이 확정되었습니다.",
      totalBets: currentBets.length,
    });
  } catch (error) {
    console.error("임시 베팅 처리 중 오류:", error);
  }
}

// 자동 베팅 시작 함수 (통합)
function startAutoBetting() {
  console.log(
    "🤖 자동 베팅 시작 호출됨, 자동게임 상태:",
    autoGameState.isActive
  );
  if (!autoGameState.isActive) return;

  const bettingDuration = 16; // 16초
  const endTime = new Date(Date.now() + bettingDuration * 1000);

  // 베팅 활성화
  bettingActive = true;
  bettingEndTime = endTime;

  // 임시 베팅 초기화
  tempBets.clear();

  // 베팅 통계 초기화
  currentBettingStats = {
    player: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
    banker: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
    tie: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
    player_pair: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
    banker_pair: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
  };

  // 모든 클라이언트에게 베팅 시작과 종료 시간 알림
  io.emit("betting_started");
  io.emit("betting_end_time", endTime);

  // 16초 후 베팅 종료 및 게임 시작
  autoGameState.bettingTimer = setTimeout(async () => {
    if (!bettingActive || !autoGameState.isActive) return;

    bettingActive = false;
    bettingEndTime = null;
    io.emit("betting_closed");

    // 임시 베팅을 실제 베팅으로 변환
    await processTempBetsToReal();

    // 바로 게임 시작
    setTimeout(() => {
      if (autoGameState.isActive) {
        startAutoGame();
      }
    }, 2000); // 2초 후 게임 시작
  }, bettingDuration * 1000);
}

// 자동 게임 시작 함수 (통합)
function startAutoGame() {
  if (!autoGameState.isActive) return;

  // 게임 실행 (조작된 결과가 있으면 그것을 사용)
  let gameResult;
  if (fixedGameResult) {
    console.log("🎮 자동게임: 조작된 게임 실행:", fixedGameResult);
    gameResult = baccaratGame.playFixedGame(fixedGameResult);
    console.log("🎯 자동게임: 조작 게임 결과:", gameResult.result);
    fixedGameResult = null; // 사용 후 초기화
    console.log("🔄 자동게임: 조작 결과 초기화 완료");
  } else {
    console.log("🎲 자동게임: 일반 게임 실행");
    gameResult = baccaratGame.playGame();
    console.log("🎯 자동게임: 일반 게임 결과:", gameResult.result);
  }

  // 현재 게임 결과 저장 (베팅 통계 포함)
  const processedGameResult = {
    ...gameResult,
    stats: currentBettingStats,
    totalBets: currentBets.reduce((sum, bet) => sum + bet.amount, 0),
    playerCount: new Set(currentBets.map((bet) => bet.userId)).size,
  };

  // 카드 정보를 user.html로 전송하고, 완료 후 게임 결과 처리
  sendCardsToUserHtml(gameResult, async () => {
    // 모든 클라이언트에게 게임 결과 전송
    io.emit("game_result", {
      result: gameResult.result,
      playerScore: gameResult.playerScore,
      bankerScore: gameResult.bankerScore,
      playerPairOccurred: gameResult.playerPairOccurred,
      bankerPairOccurred: gameResult.bankerPairOccurred,
      timestamp: gameResult.timestamp,
    });

    // 관리자에게도 카드 정보와 함께 결과 전송
    io.emit("game_result_with_cards", {
      ...gameResult,
      deckInfo: baccaratGame.getDeckInfo(),
    });

    // 5초 후 결과 처리
    setTimeout(async () => {
      await processAutoGameResult(processedGameResult);

      // 게임 카운트 증가
      autoGameState.gameCount++;

      // 자동 게임 상태 업데이트를 admin에게 전송
      if (autoGameState.adminSocketId) {
        const adminSocket = [...io.sockets.sockets.values()].find(
          (s) => s.id === autoGameState.adminSocketId
        );
        if (adminSocket) {
          adminSocket.emit("auto_game_status", {
            isActive: autoGameState.isActive,
            gameCount: autoGameState.gameCount,
            maxGames: autoGameState.maxGames,
          });
        }
      }

      // 최대 게임 수 체크 (0이면 무제한)
      if (
        autoGameState.maxGames > 0 &&
        autoGameState.gameCount >= autoGameState.maxGames
      ) {
        stopAutoGame();
        return;
      }

      // 다음 게임 스케줄 (3초 후)
      if (autoGameState.isActive) {
        autoGameState.gameTimer = setTimeout(() => {
          if (autoGameState.isActive) {
            startAutoBetting();
          }
        }, 3000);
      }
    }, 5000);
  });
}

// 자동 게임 결과 처리 함수 (통합)
async function processAutoGameResult(processedGameResult) {
  if (resultProcessing) return;
  resultProcessing = true;

  try {
    // 게임 결과 DB 저장
    const game = new Game({
      result: processedGameResult.result,
      playerPairOccurred: processedGameResult.playerPairOccurred || false,
      bankerPairOccurred: processedGameResult.bankerPairOccurred || false,
      stats: processedGameResult.stats,
      totalBets: processedGameResult.totalBets,
      playerCount: processedGameResult.playerCount,
      date: new Date(processedGameResult.timestamp),
    });
    await game.save();

    // 베팅이 있는 경우에만 정산 처리
    if (currentBets.length > 0) {
      // 사용자별 총 베팅 금액 계산
      const userTotalBets = {};
      currentBets.forEach((bet) => {
        if (!userTotalBets[bet.userId]) {
          userTotalBets[bet.userId] = {};
        }
        if (!userTotalBets[bet.userId][bet.choice]) {
          userTotalBets[bet.userId][bet.choice] = 0;
        }
        userTotalBets[bet.userId][bet.choice] += bet.amount;
      });

      // 베팅 정산
      for (const bet of currentBets) {
        try {
          const user = await User.findById(bet.userId);
          if (!user) continue;

          let finalWinnings = 0;
          let finalOutcome = "lose";

          // 승리 조건 계산 (기존 로직과 동일)
          if (
            bet.choice === "player" &&
            processedGameResult.result === "player"
          ) {
            finalWinnings = bet.amount * 2;
            finalOutcome = "win";
          } else if (
            bet.choice === "banker" &&
            processedGameResult.result === "banker"
          ) {
            finalWinnings = bet.amount * 1.95;
            finalOutcome = "win";
          } else if (
            bet.choice === "tie" &&
            processedGameResult.result === "tie"
          ) {
            finalWinnings = bet.amount * 9;
            finalOutcome = "win";
          } else if (
            bet.choice === "player_pair" &&
            processedGameResult.playerPairOccurred
          ) {
            finalWinnings = bet.amount * 12;
            finalOutcome = "win";
          } else if (
            bet.choice === "banker_pair" &&
            processedGameResult.bankerPairOccurred
          ) {
            finalWinnings = bet.amount * 12;
            finalOutcome = "win";
          } else if (
            (bet.choice === "player" || bet.choice === "banker") &&
            processedGameResult.result === "tie"
          ) {
            finalWinnings = bet.amount;
            finalOutcome = "draw";
          }

          user.balance += finalWinnings;
          user.bettingHistory.push({
            choice: bet.choice,
            amount: bet.amount,
            result: finalOutcome,
            gameResult: processedGameResult.result,
            date: new Date(),
          });

          await user.save();

          // 승리자에게 알림
          if (finalOutcome === "win") {
            const userSocket = userSockets.get(bet.userId);
            if (userSocket) {
              userSocket.emit("you_won", {
                choice: bet.choice,
                amount: bet.amount,
                winnings: finalWinnings,
                gameResult: processedGameResult.result,
              });
            }
          }
        } catch (err) {
          console.error("Background bet processing error:", err);
        }
      }
    }

    // 리더보드 업데이트
    await updateAndBroadcastLeaderboard();

    // 베팅 초기화
    currentBets = [];
    currentBettingStats = {
      player: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      banker: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      tie: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      player_pair: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      banker_pair: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
    };

    // 모든 클라이언트에게 결과 승인 및 잔액 업데이트 알림
    io.emit("result_approved");
    io.emit("update_coins");
    io.emit("betting_status", { active: false, stats: currentBettingStats });
  } catch (err) {
    console.error("Background game result processing error:", err);
  } finally {
    resultProcessing = false;
  }
}

// 자동 게임 중지 함수 (통합)
function stopAutoGame() {
  autoGameState.isActive = false;

  // 타이머들 정리
  if (autoGameState.gameTimer) {
    clearTimeout(autoGameState.gameTimer);
    autoGameState.gameTimer = null;
  }

  if (autoGameState.bettingTimer) {
    clearTimeout(autoGameState.bettingTimer);
    autoGameState.bettingTimer = null;
  }

  // 진행 중인 베팅이 있다면 종료
  if (bettingActive) {
    bettingActive = false;
    bettingEndTime = null;
    io.emit("betting_closed");
  }

  // admin에게 중지 알림
  if (autoGameState.adminSocketId) {
    const adminSocket = [...io.sockets.sockets.values()].find(
      (s) => s.id === autoGameState.adminSocketId
    );
    if (adminSocket) {
      adminSocket.emit("auto_game_stopped", {
        gameCount: autoGameState.gameCount,
        maxGames: autoGameState.maxGames,
      });
    }
  }

  // 상태 초기화
  autoGameState.gameCount = 0;
  autoGameState.maxGames = 0;
  autoGameState.adminSocketId = null;
}

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

        // 임시 베팅에서 사용자 베팅 정보 확인
        let myCurrentBetsOnChoices = {};

        if (tempBets.has(userId)) {
          // choice별 총액에서 베팅 정보 가져오기
          myCurrentBetsOnChoices = tempBets.get(userId).bets;
        } else {
          // 실제 베팅에서 확인 (게임 진행 중인 경우)
          myCurrentBetsOnChoices = currentBets.reduce((acc, curBet) => {
            if (curBet.userId === userId) {
              acc[curBet.choice] = (acc[curBet.choice] || 0) + curBet.amount;
            }
            return acc;
          }, {});
        }

        socket.emit("my_bets_updated", { myCurrentBetsOnChoices });
      } catch (err) {
        // 내 베팅 정보 요청 처리 실패
      }
    });
  }

  // 사용자 인증 및 소켓 등록
  socket.on("authenticate", async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;

      // 사용자 정보 조회해서 권한 저장
      const user = await User.findById(userId).select("role");
      if (user) {
        socket.userRole = user.role;
        socket.userId = userId;
        userSockets.set(userId, socket);
      }
    } catch (err) {
      // 소켓 인증 실패
    }
  });

  // 채팅 관련 Socket 이벤트들
  socket.on("join_chat", () => {
    // 사용자가 채팅에 참여했음을 기록
    if (socket.userId) {
    }
  });

  socket.on("send_chat_message", async (data) => {
    try {
      if (!socket.userId || !data.message) return;

      const user = await User.findById(socket.userId).select("username role");
      if (!user) return;

      const message = data.message.trim();
      if (message === "" || message.length > 500) return;

      const isAdmin = user.role === "admin";

      // 채팅 메시지 저장
      const chatMessage = new Chat({
        userId: user._id,
        username: user.username,
        message: message,
        isAdmin: isAdmin,
        isHighlighted: isAdmin, // admin 메시지는 기본적으로 강조
      });

      await chatMessage.save();

      // 모든 연결된 사용자에게 브로드캐스트
      const messageData = {
        _id: chatMessage._id,
        userId: chatMessage.userId,
        username: chatMessage.username,
        message: chatMessage.message,
        isAdmin: chatMessage.isAdmin,
        isHighlighted: chatMessage.isHighlighted,
        createdAt: chatMessage.createdAt,
      };

      // 모든 소켓에 채팅 메시지 전송
      io.emit("new_chat_message", messageData);

      // Admin 메시지인 경우 특별한 알림 추가
      if (isAdmin) {
        io.emit("admin_message_notification", {
          message: messageData,
          type: "admin_chat",
        });
      }
    } catch (err) {
      console.error("Chat message error:", err);
    }
  });

  // 강조 메시지 전송 처리
  socket.on("send_highlight_message", async (data) => {
    try {
      if (!socket.userId || !data.message) return;

      const user = await User.findById(socket.userId).select("username role");
      if (!user) return;

      const message = data.message.trim();
      if (message === "" || message.length > 500) return;

      // 강조 메시지 저장 (일반 채팅으로 저장하되 강조 표시)
      const chatMessage = new Chat({
        userId: user._id,
        username: user.username,
        message: message,
        isAdmin: false,
        isHighlighted: true, // 강조 메시지로 표시
      });

      await chatMessage.save();

      // 메시지 데이터 준비
      const messageData = {
        _id: chatMessage._id,
        userId: chatMessage.userId,
        username: chatMessage.username,
        message: chatMessage.message,
        isAdmin: chatMessage.isAdmin,
        isHighlighted: chatMessage.isHighlighted,
        createdAt: chatMessage.createdAt,
      };

      // 모든 소켓에 일반 채팅 메시지로 전송 (채팅 기록용)
      io.emit("new_chat_message", messageData);

      // 강조 메시지 특별 알림 전송 (2초간 상단 알림바 표시용)
      io.emit("highlight_message_notification", {
        message: messageData,
        type: "highlight_chat",
      });
    } catch (err) {
      console.error("Highlight message error:", err);
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
    const bettingDuration = 16; // 16초
    const endTime = new Date(Date.now() + bettingDuration * 1000);

    // 베팅 활성화
    bettingActive = true;
    bettingEndTime = endTime;

    // 임시 베팅 초기화
    tempBets.clear();

    // 베팅 통계 초기화
    currentBettingStats = {
      player: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      banker: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      tie: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      player_pair: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      banker_pair: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
    };

    // 모든 클라이언트에게 베팅 시작과 종료 시간 알림
    io.emit("betting_started");
    io.emit("betting_end_time", endTime);

    // 16초 후 베팅 종료
    setTimeout(async () => {
      if (!bettingActive) return; // 이미 다른 로직으로 종료되었다면 실행 안함
      bettingActive = false;
      bettingEndTime = null;
      io.emit("betting_closed");

      // 임시 베팅을 실제 베팅으로 변환
      await processTempBetsToReal();
    }, bettingDuration * 1000);
  });

  // 관리자용 게임 시작 이벤트
  socket.on("admin_start_game", async () => {
    console.log("🎮 admin_start_game 이벤트 받음");

    // 이미 게임이 진행 중이면 무시
    if (resultProcessing) {
      console.log("❌ 이미 게임 진행 중, 무시");
      return;
    }

    if (bettingActive) {
      console.log("🔴 베팅 종료 처리");
      bettingActive = false;
      bettingEndTime = null;
      io.emit("betting_closed");

      // 임시 베팅을 실제 베팅으로 변환
      await processTempBetsToReal();
    }

    // 게임 실행 (조작된 결과가 있으면 그것을 사용)
    let gameResult;
    if (fixedGameResult) {
      console.log("🎮 조작된 게임 실행:", fixedGameResult);
      gameResult = baccaratGame.playFixedGame(fixedGameResult);
      console.log("🎯 조작 게임 결과:", gameResult.result);
      fixedGameResult = null; // 사용 후 초기화
      console.log("🔄 조작 결과 초기화 완료");
    } else {
      console.log("🎲 일반 게임 실행");
      gameResult = baccaratGame.playGame();
      console.log("🎯 일반 게임 결과:", gameResult.result);
    }

    // 현재 게임 결과 저장 (베팅 통계 포함)
    const processedGameResult = {
      ...gameResult,
      stats: currentBettingStats,
      totalBets: currentBets.reduce((sum, bet) => sum + bet.amount, 0),
      playerCount: new Set(currentBets.map((bet) => bet.userId)).size,
    };

    // 카드 정보를 user.html로 전송하고, 완료 후 게임 결과 처리
    sendCardsToUserHtml(gameResult, async () => {
      // 모든 클라이언트에게 게임 결과 전송
      io.emit("game_result", {
        result: gameResult.result,
        playerScore: gameResult.playerScore,
        bankerScore: gameResult.bankerScore,
        playerPairOccurred: gameResult.playerPairOccurred,
        bankerPairOccurred: gameResult.bankerPairOccurred,
        timestamp: gameResult.timestamp,
      });

      // 관리자에게도 카드 정보와 함께 결과 전송
      io.emit("game_result_with_cards", {
        ...gameResult,
        deckInfo: baccaratGame.getDeckInfo(),
      });

      // 게임 결과를 5초간 표시한 후 처리 시작
      setTimeout(async () => {
        // 결과 처리 로직 시작
        if (resultProcessing) {
          return;
        }
        resultProcessing = true;

        try {
          // 게임 결과 DB 저장
          const game = new Game({
            result: processedGameResult.result,
            playerPairOccurred: processedGameResult.playerPairOccurred || false,
            bankerPairOccurred: processedGameResult.bankerPairOccurred || false,
            stats: processedGameResult.stats,
            totalBets: processedGameResult.totalBets,
            playerCount: processedGameResult.playerCount,
            date: new Date(processedGameResult.timestamp),
          });
          await game.save();

          // 사용자별 총 베팅 금액 계산
          const userTotalBets = {};
          currentBets.forEach((bet) => {
            if (!userTotalBets[bet.userId]) {
              userTotalBets[bet.userId] = {};
            }
            if (!userTotalBets[bet.userId][bet.choice]) {
              userTotalBets[bet.userId][bet.choice] = 0;
            }
            userTotalBets[bet.userId][bet.choice] += bet.amount;
          });

          // 베팅 정산
          for (const bet of currentBets) {
            try {
              const user = await User.findById(bet.userId);
              if (!user) continue;

              let finalWinnings = 0;
              let finalOutcome = "lose";

              if (bet.choice === "player") {
                if (processedGameResult.result === "player") {
                  finalWinnings = bet.amount * 2;
                  finalOutcome = "win";
                } else if (processedGameResult.result === "tie") {
                  finalWinnings = bet.amount;
                  finalOutcome = "draw";
                }
              } else if (bet.choice === "banker") {
                if (processedGameResult.result === "banker") {
                  finalWinnings = bet.amount * 1.95;
                  finalOutcome = "win";
                } else if (processedGameResult.result === "tie") {
                  finalWinnings = bet.amount;
                  finalOutcome = "draw";
                }
              } else if (bet.choice === "tie") {
                if (processedGameResult.result === "tie") {
                  finalWinnings = bet.amount * 9; // 8:1
                  finalOutcome = "win";
                }
              } else if (bet.choice === "player_pair") {
                if (processedGameResult.playerPairOccurred) {
                  finalWinnings = bet.amount * 12; // 11:1
                  finalOutcome = "win";
                }
              } else if (bet.choice === "banker_pair") {
                if (processedGameResult.bankerPairOccurred) {
                  finalWinnings = bet.amount * 12; // 11:1
                  finalOutcome = "win";
                }
              }

              user.balance += finalWinnings;

              user.bettingHistory.push({
                choice: bet.choice,
                amount: bet.amount,
                result: finalOutcome,
                gameResult: processedGameResult.result,
                date: new Date(),
              });

              await user.save();
            } catch (err) {
              console.error("Bet processing error:", err);
            }
          }

          // 승리한 사용자들에게 승리 알림 전송 (중복 제거)
          const notifiedUsers = new Set();
          for (const bet of currentBets) {
            try {
              const userId = bet.userId.toString();
              if (notifiedUsers.has(userId + bet.choice)) continue;

              let finalOutcome = "lose";
              let totalWinnings = 0;
              const userTotalBetAmount = userTotalBets[bet.userId]
                ? userTotalBets[bet.userId][bet.choice]
                : 0;

              if (bet.choice === "player") {
                if (processedGameResult.result === "player") {
                  totalWinnings = userTotalBetAmount * 2;
                  finalOutcome = "win";
                } else if (processedGameResult.result === "tie") {
                  totalWinnings = userTotalBetAmount;
                  finalOutcome = "draw";
                }
              } else if (bet.choice === "banker") {
                if (processedGameResult.result === "banker") {
                  totalWinnings = userTotalBetAmount * 1.95;
                  finalOutcome = "win";
                } else if (processedGameResult.result === "tie") {
                  totalWinnings = userTotalBetAmount;
                  finalOutcome = "draw";
                }
              } else if (bet.choice === "tie") {
                if (processedGameResult.result === "tie") {
                  totalWinnings = userTotalBetAmount * 9; // 8:1
                  finalOutcome = "win";
                }
              } else if (bet.choice === "player_pair") {
                if (processedGameResult.playerPairOccurred) {
                  totalWinnings = userTotalBetAmount * 12; // 11:1
                  finalOutcome = "win";
                }
              } else if (bet.choice === "banker_pair") {
                if (processedGameResult.bankerPairOccurred) {
                  totalWinnings = userTotalBetAmount * 12; // 11:1
                  finalOutcome = "win";
                }
              }

              // 승리한 사용자에게 승리 알림 전송
              if (finalOutcome === "win") {
                const userSocket = userSockets.get(userId);
                if (userSocket) {
                  userSocket.emit("you_won", {
                    choice: bet.choice,
                    totalBetAmount: userTotalBetAmount,
                    winnings: totalWinnings,
                    gameResult: processedGameResult.result,
                  });
                  notifiedUsers.add(userId + bet.choice);
                } else {
                }
              }
            } catch (err) {
              console.error("Win notification error:", err);
            }
          }

          // 결과 승인됨을 클라이언트에 알림
          io.emit("result_approved");
          io.emit("update_coins");

          // 관리자에게 결과 처리 완료 알림
          io.emit("admin_result_approved", {
            message: "게임 결과가 자동으로 처리되었습니다.",
            gameResult: processedGameResult.result,
            timestamp: new Date(),
          });

          // 리더보드 업데이트 (게임 결과로 인한 잔액 변동 반영)
          await updateAndBroadcastLeaderboard();

          // 상태 초기화
          currentBets = [];
          tempBets.clear(); // 임시 베팅도 초기화
          currentBettingStats = {
            player: {
              count: 0,
              total: 0,
              bettor_count: 0,
              total_bet_amount: 0,
            },
            banker: {
              count: 0,
              total: 0,
              bettor_count: 0,
              total_bet_amount: 0,
            },
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
          userCache.clear();

          io.emit("betting_status", {
            active: bettingActive,
            endTime: bettingEndTime,
            stats: currentBettingStats,
          });
        } catch (err) {
          console.error("Game result processing error:", err);
          socket.emit("error", "게임 결과 처리 중 오류가 발생했습니다.");
        } finally {
          resultProcessing = false;
        }
      }, 1500); // 1.5초 후 결과 처리
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

  // 승부 조작 이벤트 (관리자 전용)
  socket.on("admin_fix_result", (data) => {
    console.log("🎯 서버: 조작 요청 받음:", data);
    const { result, pattern } = data;

    // 관리자 권한 확인
    console.log("👤 사용자 권한:", socket.userRole);
    if (!socket.userRole || socket.userRole !== "admin") {
      console.log("❌ 권한 없음");
      return socket.emit("error", "관리자 권한이 필요합니다.");
    }

    // 베팅이 활성화되어 있을 때만 조작 가능
    console.log("🎲 베팅 상태:", bettingActive);
    if (!bettingActive) {
      console.log("❌ 베팅 시간 아님");
      return socket.emit("error", "베팅 시간이 아닙니다.");
    }

    // 유효한 결과인지 확인
    const validResults = ["player", "banker", "tie"];
    const baseResult = result.split("_")[0];
    if (!validResults.includes(baseResult)) {
      console.log("❌ 유효하지 않은 결과:", baseResult);
      return socket.emit("error", "유효하지 않은 결과입니다.");
    }

    // 패턴이 지정되지 않았으면 기본 패턴 사용
    const patternNum = pattern || 1;
    const fixedResultWithPattern = `${baseResult}_${patternNum}`;

    // 조작된 결과 설정
    fixedGameResult = fixedResultWithPattern;
    console.log("✅ 조작 결과 설정 완료:", fixedGameResult);

    const resultName =
      baseResult === "player"
        ? "플레이어"
        : baseResult === "banker"
        ? "뱅커"
        : "타이";

    // 관리자에게 확인 메시지 전송
    socket.emit("result_fixed", {
      message: `다음 게임 결과가 ${resultName} 승리로 설정되었습니다.`,
      fixedResult: fixedResultWithPattern,
      pattern: patternNum,
    });
    console.log("📤 조작 설정 확인 메시지 전송 완료");
  });

  // 자동 게임 시작 이벤트 (관리자 전용) - 자동시작과 백그라운드 통합
  socket.on("start_auto_game", (data) => {
    const { maxGames } = data; // 0이면 무제한 (계속)

    // 이미 자동 게임이 진행 중인지 확인
    if (autoGameState.isActive) {
      return socket.emit("error", "이미 자동 게임이 진행 중입니다.");
    }

    // 현재 베팅이나 게임이 진행 중인지 확인
    if (bettingActive || resultProcessing) {
      return socket.emit(
        "error",
        "현재 게임이 진행 중입니다. 잠시 후 다시 시도해주세요."
      );
    }

    // 유효한 게임 수인지 확인 (0은 무제한)
    if (maxGames < 0 || maxGames > 1000) {
      return socket.emit(
        "error",
        "게임 수는 0회(무제한)에서 1000회 사이여야 합니다."
      );
    }

    // 자동 게임 상태 설정
    autoGameState.isActive = true;
    autoGameState.gameCount = 0;
    autoGameState.maxGames = maxGames;
    autoGameState.adminSocketId = socket.id;

    // 시작 확인 메시지 전송
    const gameTypeText = maxGames === 0 ? "무제한" : `${maxGames}회`;
    socket.emit("auto_game_started", {
      message: `자동 게임이 시작되었습니다. (${gameTypeText})`,
      maxGames: maxGames,
      gameCount: 0,
    });

    // 첫 번째 베팅 시작 (1초 후)
    setTimeout(() => {
      if (autoGameState.isActive) {
        startAutoBetting();
      }
    }, 1000);
  });

  // 자동 게임 중지 이벤트 (관리자 전용)
  socket.on("stop_auto_game", () => {
    if (!autoGameState.isActive) {
      return socket.emit("error", "자동 게임이 진행 중이지 않습니다.");
    }

    stopAutoGame();
    const gameTypeText =
      autoGameState.maxGames === 0 ? "무제한" : autoGameState.maxGames;
    socket.emit("auto_game_stopped", {
      message: `자동 게임이 중지되었습니다. (완료된 게임: ${autoGameState.gameCount}/${gameTypeText})`,
      gameCount: autoGameState.gameCount,
      maxGames: autoGameState.maxGames,
    });
  });

  // 자동 게임 상태 요청 이벤트
  socket.on("get_auto_game_status", () => {
    socket.emit("auto_game_status", {
      isActive: autoGameState.isActive,
      gameCount: autoGameState.gameCount,
      maxGames: autoGameState.maxGames,
    });
  });

  // 임시 베팅 처리 함수
  const processTempBetting = (userId, choice, amount, username) => {
    // 임시 베팅 저장소에서 사용자 베팅 정보 가져오기
    if (!tempBets.has(userId)) {
      tempBets.set(userId, {
        username: username,
        bets: {}, // choice별 총액 저장
        betHistory: [], // 모든 베팅 액션을 순서대로 저장
        totalAmount: 0,
      });
    }

    const userTempBets = tempBets.get(userId);

    // 선택지별 베팅액 추가
    if (!userTempBets.bets[choice]) {
      userTempBets.bets[choice] = 0;
    }
    userTempBets.bets[choice] += amount;
    userTempBets.totalAmount += amount;

    // 베팅 액션을 히스토리에 추가 (최대 100개로 제한)
    userTempBets.betHistory.push({
      choice: choice,
      amount: amount,
      timestamp: Date.now(),
    });

    // 베팅 히스토리가 너무 길어지면 오래된 것부터 제거 (메모리 최적화)
    if (userTempBets.betHistory.length > 100) {
      userTempBets.betHistory.shift();
    }

    return userTempBets;
  };

  // 베팅 통계 업데이트 함수 (성능 최적화)
  const updateBettingStats = () => {
    // 통계 초기화
    currentBettingStats = {
      player: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      banker: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      tie: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      player_pair: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
      banker_pair: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
    };

    // 임시 베팅에서 통계 계산 (O(n) 최적화)
    const tempBetsCount = tempBets.size;
    if (tempBetsCount === 0) return; // 베팅이 없으면 즉시 리턴

    for (const [userId, userData] of tempBets.entries()) {
      // choice별 총액에서 통계 계산
      for (const [choice, amount] of Object.entries(userData.bets)) {
        if (currentBettingStats[choice] && amount > 0) {
          currentBettingStats[choice].count++;
          currentBettingStats[choice].total += amount;
          currentBettingStats[choice].bettor_count++;
          currentBettingStats[choice].total_bet_amount += amount;
        }
      }
    }
  };

  // 베팅 데이터 수신 (새로운 임시 베팅 시스템)
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

      // 베팅 시에는 항상 최신 잔액을 DB에서 직접 조회 (캐시 사용 안 함)
      const user = await User.findById(userId).lean();
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

      // 현재 임시 베팅 총액 계산
      const currentTempBetAmount = tempBets.has(userId)
        ? tempBets.get(userId).totalAmount
        : 0;
      const totalBetAmount = currentTempBetAmount + amount;

      if (user.balance < totalBetAmount) {
        return socket.emit("error", "잔액이 부족합니다.");
      }

      // 임시 베팅 처리 (메모리에만 저장)
      const userTempBets = processTempBetting(
        userId,
        choice,
        amount,
        user.username
      );

      // 베팅 통계 업데이트
      updateBettingStats();

      // 성능 모니터링 업데이트
      totalBetsProcessed++;
      const currentUsers = tempBets.size;
      if (currentUsers > maxConcurrentUsers) {
        maxConcurrentUsers = currentUsers;
      }

      // 즉시 성공 응답
      socket.emit("bet_success", {
        message: "베팅이 추가되었습니다.",
        newBalance: user.balance - userTempBets.totalAmount, // 임시 잔액 표시
      });

      // 개인 베팅 정보 업데이트
      socket.emit("my_bets_updated", {
        myCurrentBetsOnChoices: userTempBets.bets,
      });

      // 모든 클라이언트에게 베팅 통계 업데이트 전송
      io.emit("new_bet", {
        stats: currentBettingStats,
        choice: choice,
      });
    } catch (err) {
      console.error("임시 베팅 처리 에러:", err);
      socket.emit("error", "베팅 처리 중 오류가 발생했습니다.");
    }
  });

  // 임시 베팅 취소 (마지막 베팅만 취소)
  socket.on("cancel_bet", async (data) => {
    const { token } = data;

    if (!bettingActive) {
      return socket.emit("error", "베팅 시간이 종료되어 취소할 수 없습니다.");
    }

    if (!token) {
      return socket.emit("error", "인증 토큰이 필요합니다.");
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;

      // 베팅 취소 시에도 항상 최신 잔액을 DB에서 직접 조회 (캐시 사용 안 함)
      const user = await User.findById(userId).lean();
      if (!user) {
        return socket.emit("error", "사용자를 찾을 수 없습니다.");
      }

      // 임시 베팅이 있는지 확인
      if (!tempBets.has(userId)) {
        return socket.emit("error", "취소할 베팅이 없습니다.");
      }

      const userTempBets = tempBets.get(userId);

      // 베팅 히스토리가 없으면 오류
      if (userTempBets.betHistory.length === 0) {
        return socket.emit("error", "취소할 베팅이 없습니다.");
      }

      // 베팅 히스토리에서 마지막 베팅 제거
      const lastBet = userTempBets.betHistory.pop();
      const { choice, amount } = lastBet;

      // 해당 선택지에서 마지막 베팅 금액만큼 차감
      userTempBets.bets[choice] -= amount;
      userTempBets.totalAmount -= amount;

      // 해당 선택지 베팅이 0 이하가 되면 삭제
      if (userTempBets.bets[choice] <= 0) {
        delete userTempBets.bets[choice];
      }

      // 베팅이 모두 제거되었으면 사용자 전체 삭제
      if (Object.keys(userTempBets.bets).length === 0) {
        tempBets.delete(userId);
      }

      // 베팅 통계 재계산
      updateBettingStats();

      // 베팅 취소 성공 응답
      socket.emit("bet_cancelled_success", {
        message: `마지막 베팅이 취소되었습니다. (${choice} ${amount.toLocaleString()}원)`,
        newBalance: user.balance, // 원래 잔액으로 복원
        cancelledAmount: amount,
        cancelledChoice: choice,
      });

      // 개인 베팅 정보 업데이트
      const myCurrentBetsOnChoices = tempBets.has(userId)
        ? tempBets.get(userId).bets
        : {};

      socket.emit("my_bets_updated", {
        myCurrentBetsOnChoices: myCurrentBetsOnChoices,
      });

      // 모든 클라이언트에게 베팅 통계 업데이트 전송
      io.emit("new_bet", {
        stats: currentBettingStats,
      });
    } catch (err) {
      console.error("임시 베팅 취소 에러:", err);
      socket.emit("error", "베팅 취소 처리 중 오류가 발생했습니다.");
    }
  });

  // 이 부분은 이제 admin_start_game에서 직접 처리하므로 제거합니다.
  // 중복된 game_result 이벤트 핸들러를 제거하여 결과 중복 발생을 방지합니다.

  let resultProcessing = false; // 결과 처리 중복 방지 플래그는 유지

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
      .select(
        "result date stats totalBets playerCount playerPairOccurred bankerPairOccurred"
      )
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
      .select(
        "result date stats totalBets playerCount playerPairOccurred bankerPairOccurred"
      )
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
  bankName: String, // 은행명
  accountNumber: String, // 계좌번호
  accountHolder: String, // 예금주명
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
  const { amount, bankName, accountNumber, accountHolder } = req.body; // amount는 원 단위

  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    // 입력값 검증
    if (!amount || amount < 30000) {
      return res
        .status(400)
        .json({ message: "최소 30,000원부터 환전 가능합니다." });
    }

    if (!bankName || !accountNumber || !accountHolder) {
      return res
        .status(400)
        .json({ message: "은행명, 계좌번호, 예금주명을 모두 입력해주세요." });
    }

    if (user.balance < amount) {
      return res.status(400).json({ message: "보유 잔액이 부족합니다." });
    }

    // 환전 가능 금액 계산: 롤링 요구량 달성 시에만 환전 가능
    const rollingDeposit = user.rollingDeposit || 0;
    const rollingWagered = user.rollingWagered || 0;
    const rollingRequirement = rollingDeposit * 1.0;

    // 롤링 요구량을 달성한 경우에만 환전 가능
    const maxExchangeAmount =
      rollingWagered >= rollingRequirement ? user.balance : 0;

    if (amount > maxExchangeAmount) {
      return res.status(400).json({
        message: `환전 가능 금액을 초과했습니다. 최대 환전 가능: ${maxExchangeAmount.toLocaleString()}원`,
      });
    }

    // 새로운 수수료 계산 (0%)
    const fee = 0;
    const actualAmount = amount;

    // 즉시 잔액 차감 (중복 환전 방지)
    user.balance -= amount;
    await user.save();

    // 환전 요청 생성 (계좌 정보 포함)
    const exchangeRequest = new ExchangeRequest({
      userId: user._id,
      username: user.username,
      requestAmount: amount,
      actualAmount: actualAmount,
      fee,
      rollingPoint: user.rollingWagered || 0,
      bankName: bankName.trim(),
      accountNumber: accountNumber.trim(),
      accountHolder: accountHolder.trim(),
    });
    await exchangeRequest.save();

    // 사용자에게 잔액 업데이트 알림
    const userSocket = userSockets.get(user._id.toString());
    if (userSocket) {
      userSocket.emit("balance_updated", { newBalance: user.balance });
    }

    // 모든 관리자에게 새로운 환전 요청 알림 (계좌 정보 포함)
    io.emit("new_exchange_request", {
      username: user.username,
      requestAmount: amount,
      actualAmount: actualAmount,
      fee,
      bankName: bankName.trim(),
      accountNumber: accountNumber.trim(),
      accountHolder: accountHolder.trim(),
      createdAt: exchangeRequest.createdAt,
    });

    // 리더보드 업데이트
    await updateAndBroadcastLeaderboard();

    res.json({
      message: "환전 신청이 완료되었습니다. 관리자 승인을 기다려주세요.",
      newBalance: user.balance,
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
    const rollingRequirement = (user.rollingDeposit || 0) * 1.0;
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
      // 환전 승인 시에는 별도 처리 없음 (이미 신청 시 차감됨)
      // 롤링은 그대로 유지
    } else if (status === "rejected") {
      // 환전 거절 시 잔액 복원
      user.balance += request.requestAmount;
      await user.save();
    }

    request.status = status;
    await request.save();

    // 해당 유저에게 실시간 알림
    const userSocket = userSockets.get(user._id.toString());
    if (userSocket) {
      if (status === "approved") {
        userSocket.emit("exchange_request_processed", {
          status: "approved",
          requestAmount: request.requestAmount,
          actualAmount: request.actualAmount,
          newBalance: user.balance,
        });
      } else {
        userSocket.emit("balance_updated", { newBalance: user.balance });
        userSocket.emit("exchange_request_processed", {
          status: "rejected",
          requestAmount: request.requestAmount,
          actualAmount: request.actualAmount,
          newBalance: user.balance,
        });
      }
    }

    // 잔액 변동이 있는 경우 리더보드 업데이트
    // 모든 관리자에게 사용자 잔액 업데이트 알림
    io.emit("user_balance_updated", {
      userId: user._id.toString(),
      newBalance: user.balance,
    });

    // 리더보드 업데이트
    await updateAndBroadcastLeaderboard();

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

// 하우스 통계 API (총 이득/손실)
app.get("/api/admin/house-statistics", auth(["admin"]), async (req, res) => {
  try {
    // 모든 사용자의 베팅 히스토리 조회
    const users = await User.find().select("username bettingHistory");

    // 모든 베팅 기록을 하나의 배열로 통합
    const allBets = [];
    users.forEach((user) => {
      if (user.bettingHistory && user.bettingHistory.length > 0) {
        user.bettingHistory.forEach((bet) => {
          allBets.push({
            ...bet.toObject(),
            username: user.username,
          });
        });
      }
    });

    // 총 베팅액 계산
    const totalBetAmount = allBets.reduce(
      (sum, bet) => sum + (bet.amount || 0),
      0
    );

    // 총 지급액 계산 (승리한 베팅들의 지급액)
    const totalWinAmount = allBets
      .filter((bet) => bet.result === "win")
      .reduce((sum, bet) => {
        const profit = calculateProfit(bet);
        return sum + profit;
      }, 0);

    // 베팅 게임에서의 하우스 수익 = 총 베팅액 - 총 지급액
    const bettingHouseProfit = totalBetAmount - totalWinAmount;

    // 충전/환전 통계 계산
    const depositsCollection =
      mongoose.connection.db.collection("depositrequests");
    const exchangeRequestsCollection =
      mongoose.connection.db.collection("exchangerequests");

    // 승인된 충전 총액
    const approvedDeposits = await depositsCollection
      .find({ status: "approved" })
      .toArray();
    const totalDepositAmount = approvedDeposits.reduce(
      (sum, dep) => sum + (dep.amount || 0),
      0
    );

    // 승인된 환전 총액 (실제 지급액)
    const approvedExchanges = await exchangeRequestsCollection
      .find({ status: "approved" })
      .toArray();
    const totalExchangeAmount = approvedExchanges.reduce(
      (sum, ex) => sum + (ex.actualAmount || 0),
      0
    );

    // 환전 수수료 총액
    const totalExchangeFees = approvedExchanges.reduce(
      (sum, ex) => sum + (ex.fee || 0),
      0
    );

    // 현재 모든 사용자 잔액 총합
    const allUsers = await User.find().select("balance");
    const totalUserBalance = allUsers.reduce(
      (sum, user) => sum + (user.balance || 0),
      0
    );

    // 실제 하우스 순이익 계산
    // 방법 1: 충전액 - 환전액 - 현재 사용자 잔액 총합
    const realHouseProfit =
      totalDepositAmount - totalExchangeAmount - totalUserBalance;

    // 방법 2: 베팅 수익 + 환전 수수료 (검증용)
    const calculatedHouseProfit = bettingHouseProfit + totalExchangeFees;

    // 게임별 통계
    const gameResults = await Game.find();
    const gameStats = {
      totalGames: gameResults.length,
      playerWins: gameResults.filter((game) => game.result === "player").length,
      bankerWins: gameResults.filter((game) => game.result === "banker").length,
      ties: gameResults.filter((game) => game.result === "tie").length,
    };

    // 베팅 선택별 통계
    const betStats = {};
    const choices = ["player", "banker", "tie", "player_pair", "banker_pair"];

    choices.forEach((choice) => {
      const betsForChoice = allBets.filter((bet) => bet.choice === choice);
      const winBetsForChoice = betsForChoice.filter(
        (bet) => bet.result === "win"
      );

      const totalAmount = betsForChoice.reduce(
        (sum, bet) => sum + (bet.amount || 0),
        0
      );
      const winAmount = winBetsForChoice.reduce((sum, bet) => {
        const profit = calculateProfit(bet);
        return sum + profit;
      }, 0);

      betStats[choice] = {
        totalBets: betsForChoice.length,
        totalAmount,
        winCount: winBetsForChoice.length,
        winAmount,
        houseProfit: totalAmount - winAmount,
      };
    });

    // 수익률 계산
    const bettingProfitMargin =
      totalBetAmount > 0
        ? ((bettingHouseProfit / totalBetAmount) * 100).toFixed(2)
        : 0;

    // 실제 수익률 계산 (총 충전액 대비)
    const realProfitMargin =
      totalDepositAmount > 0
        ? ((realHouseProfit / totalDepositAmount) * 100).toFixed(2)
        : 0;

    // 오늘 통계
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayBets = allBets.filter((bet) => {
      const betDate = new Date(bet.date);
      return betDate >= today;
    });
    const todayBetAmount = todayBets.reduce(
      (sum, bet) => sum + (bet.amount || 0),
      0
    );
    const todayWinAmount = todayBets
      .filter((bet) => bet.result === "win")
      .reduce((sum, bet) => {
        const profit = calculateProfit(bet);
        return sum + profit;
      }, 0);
    const todayHouseProfit = todayBetAmount - todayWinAmount;

    // 이번 주 통계
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const weekBets = allBets.filter((bet) => {
      const betDate = new Date(bet.date);
      return betDate >= weekStart;
    });
    const weekBetAmount = weekBets.reduce(
      (sum, bet) => sum + (bet.amount || 0),
      0
    );
    const weekWinAmount = weekBets
      .filter((bet) => bet.result === "win")
      .reduce((sum, bet) => {
        const profit = calculateProfit(bet);
        return sum + profit;
      }, 0);
    const weekHouseProfit = weekBetAmount - weekWinAmount;

    // 사용자별 기여도 (상위 10명)
    const userContributions = {};
    allBets.forEach((bet) => {
      if (!userContributions[bet.username]) {
        userContributions[bet.username] = {
          totalBet: 0,
          totalWin: 0,
          contribution: 0,
        };
      }
      userContributions[bet.username].totalBet += bet.amount || 0;
      if (bet.result === "win") {
        const profit = calculateProfit(bet);
        userContributions[bet.username].totalWin += profit;
      }
      userContributions[bet.username].contribution =
        userContributions[bet.username].totalBet -
        userContributions[bet.username].totalWin;
    });

    const topContributors = Object.entries(userContributions)
      .map(([username, stats]) => ({ username, ...stats }))
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 10);

    res.json({
      overall: {
        totalBetAmount,
        totalWinAmount,
        bettingHouseProfit,
        bettingProfitMargin: parseFloat(bettingProfitMargin),
        realHouseProfit,
        realProfitMargin: parseFloat(realProfitMargin),
        totalBets: allBets.length,
      },
      financial: {
        totalDepositAmount,
        totalExchangeAmount,
        totalExchangeFees,
        totalUserBalance,
        calculatedHouseProfit, // 검증용
      },
      gameStats,
      betStats,
      period: {
        today: {
          betAmount: todayBetAmount,
          winAmount: todayWinAmount,
          houseProfit: todayHouseProfit,
          betCount: todayBets.length,
        },
        week: {
          betAmount: weekBetAmount,
          winAmount: weekWinAmount,
          houseProfit: weekHouseProfit,
          betCount: weekBets.length,
        },
      },
      topContributors,
    });
  } catch (err) {
    console.error("하우스 통계 조회 오류:", err);
    res.status(500).json({ message: "서버 오류가 발생했습니다." });
  }
});

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
    if (amount < 20000) {
      return res
        .status(400)
        .json({ message: "최소 20,000원부터 충전 가능합니다." });
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
      // 잔액 증가 및 롤링 초기화
      user.balance += request.amount;

      // 새로 충전할 때마다 롤링 초기화 및 새로운 롤링 설정
      user.rollingDeposit = request.amount; // 새 충전액으로 초기화
      user.rollingWagered = 0; // 베팅액 초기화

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

      // 리더보드 업데이트
      await updateAndBroadcastLeaderboard();
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

// 채팅 스키마
const chatSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  username: {
    type: String,
    required: true,
  },
  message: {
    type: String,
    required: true,
    maxlength: 500,
  },
  isAdmin: {
    type: Boolean,
    default: false,
  },
  isHighlighted: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Chat = mongoose.model("Chat", chatSchema);

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

    const fee = 0; // 0% 수수료
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

    // 리더보드 업데이트 (송금으로 인한 잔액 변동 반영)
    await updateAndBroadcastLeaderboard();

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

      const fee = 0; // 0% 수수료
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

      // 리더보드 업데이트 (머니 요청 수락으로 인한 잔액 변동 반영)
      await updateAndBroadcastLeaderboard();

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
// 채팅 API
// =====================

// 채팅 기록 조회 API
app.get("/api/chat/messages", auth(), async (req, res) => {
  try {
    const messages = await Chat.find().sort({ createdAt: -1 }).limit(50).lean();

    // 최신 순으로 정렬 (UI에서 표시할 때는 오래된 순으로)
    const sortedMessages = messages.reverse();

    res.json(sortedMessages);
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// 채팅 전송 API
app.post("/api/chat/send", auth(), async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || message.trim() === "" || message.length > 500) {
      return res.status(400).json({
        message: "메시지가 비어있거나 500자를 초과합니다.",
      });
    }

    const user = await User.findById(req.user.id).select("username role");
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    const isAdmin = user.role === "admin";

    // 채팅 메시지 저장
    const chatMessage = new Chat({
      userId: user._id,
      username: user.username,
      message: message.trim(),
      isAdmin: isAdmin,
      isHighlighted: isAdmin, // admin 메시지는 기본적으로 강조
    });

    await chatMessage.save();

    // 모든 연결된 사용자에게 브로드캐스트
    const messageData = {
      _id: chatMessage._id,
      userId: chatMessage.userId,
      username: chatMessage.username,
      message: chatMessage.message,
      isAdmin: chatMessage.isAdmin,
      isHighlighted: chatMessage.isHighlighted,
      createdAt: chatMessage.createdAt,
    };

    // 모든 소켓에 채팅 메시지 전송
    io.emit("new_chat_message", messageData);

    res.json({ message: "채팅이 전송되었습니다." });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// 채팅 메시지 삭제 API (관리자만)
app.delete("/api/chat/message/:messageId", auth("admin"), async (req, res) => {
  try {
    const { messageId } = req.params;

    const deletedMessage = await Chat.findByIdAndDelete(messageId);
    if (!deletedMessage) {
      return res.status(404).json({ message: "메시지를 찾을 수 없습니다." });
    }

    // 모든 사용자에게 메시지 삭제 알림
    io.emit("chat_message_deleted", { messageId });

    res.json({ message: "메시지가 삭제되었습니다." });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================
// 서버 시작
// =====================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 시작되었습니다.`);
  console.log(`MongoDB 연결: ${MONGO_URI}`);
  console.log(`프론트엔드 URL: ${FRONTEND_URL}`);
  console.log(`바카라 게임 서버 준비 완료!`);
});
