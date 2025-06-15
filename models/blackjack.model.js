const mongoose = require("mongoose");

// 블랙잭 게임 기록 스키마
const blackjackGameSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
  },
  roomName: {
    type: String,
    required: true,
  },
  gameStartTime: {
    type: Date,
    required: true,
  },
  gameEndTime: {
    type: Date,
    default: Date.now,
  },
  dealerCards: [
    {
      value: String,
      suit: String,
    },
  ],
  dealerScore: {
    type: Number,
    required: true,
  },
  dealerBusted: {
    type: Boolean,
    default: false,
  },
  players: [
    {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
      username: {
        type: String,
        required: true,
      },
      seatNumber: {
        type: Number,
        required: true,
      },
      cards: [
        {
          value: String,
          suit: String,
        },
      ],
      score: {
        type: Number,
        required: true,
      },
      betAmount: {
        type: Number,
        required: true,
      },
      result: {
        type: String,
        enum: ["win", "lose", "push", "blackjack", "bust"],
        required: true,
      },
      payout: {
        type: Number,
        required: true,
      },
      isBlackjack: {
        type: Boolean,
        default: false,
      },
      isBusted: {
        type: Boolean,
        default: false,
      },
      hasDoubled: {
        type: Boolean,
        default: false,
      },
      insurance: {
        type: Number,
        default: 0,
      },
    },
  ],
  totalBets: {
    type: Number,
    required: true,
  },
  totalPayouts: {
    type: Number,
    required: true,
  },
  houseProfit: {
    type: Number,
    required: true,
  },
});

// 블랙잭 플레이어 통계 스키마
const blackjackPlayerStatsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    username: {
      type: String,
      required: true,
    },
    totalGames: {
      type: Number,
      default: 0,
    },
    wins: {
      type: Number,
      default: 0,
    },
    losses: {
      type: Number,
      default: 0,
    },
    pushes: {
      type: Number,
      default: 0,
    },
    blackjacks: {
      type: Number,
      default: 0,
    },
    busts: {
      type: Number,
      default: 0,
    },
    totalBets: {
      type: Number,
      default: 0,
    },
    totalWinnings: {
      type: Number,
      default: 0,
    },
    totalProfit: {
      type: Number,
      default: 0,
    },
    winRate: {
      type: Number,
      default: 0,
    },
    avgBetSize: {
      type: Number,
      default: 0,
    },
    bestWinStreak: {
      type: Number,
      default: 0,
    },
    currentWinStreak: {
      type: Number,
      default: 0,
    },
    bestLoseStreak: {
      type: Number,
      default: 0,
    },
    currentLoseStreak: {
      type: Number,
      default: 0,
    },
    handsDoubled: {
      type: Number,
      default: 0,
    },
    insuranceTaken: {
      type: Number,
      default: 0,
    },
    lastPlayedAt: {
      type: Date,
    },
    monthlyStats: [
      {
        year: Number,
        month: Number,
        games: { type: Number, default: 0 },
        wins: { type: Number, default: 0 },
        losses: { type: Number, default: 0 },
        profit: { type: Number, default: 0 },
        totalBets: { type: Number, default: 0 },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// 인덱스 추가
blackjackGameSchema.index({ roomId: 1, gameStartTime: -1 });
blackjackGameSchema.index({ "players.userId": 1 });
blackjackPlayerStatsSchema.index({ totalGames: -1 });
blackjackPlayerStatsSchema.index({ winRate: -1 });
blackjackPlayerStatsSchema.index({ totalProfit: -1 });

const BlackjackGame = mongoose.model("BlackjackGame", blackjackGameSchema);
const BlackjackPlayerStats = mongoose.model(
  "BlackjackPlayerStats",
  blackjackPlayerStatsSchema
);

module.exports = {
  BlackjackGame,
  BlackjackPlayerStats,
};
