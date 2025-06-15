const mongoose = require("mongoose");

const GameHistorySchema = new mongoose.Schema(
  {
    gameType: {
      type: String,
      required: true,
      enum: ["baccarat", "blackjack"],
    },
    roomId: {
      type: String,
      required: true,
    },
    gameId: {
      type: String,
      required: true,
    },
    startTime: {
      type: Date,
      required: true,
    },
    endTime: {
      type: Date,
      required: true,
    },
    players: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        username: String,
        bet: {
          type: Number,
          default: 0,
        },
        payout: {
          type: Number,
          default: 0,
        },
        result: {
          type: String,
          enum: ["win", "lose", "tie", "blackjack", "bust"],
        },
        cards: [
          {
            suit: String,
            value: String,
          },
        ],
        score: Number,
      },
    ],
    dealer: {
      cards: [
        {
          suit: String,
          value: String,
        },
      ],
      score: Number,
    },
    gameResult: {
      type: String,
      enum: ["player_win", "dealer_win", "tie"],
    },
    totalBets: {
      type: Number,
      default: 0,
    },
    totalPayouts: {
      type: Number,
      default: 0,
    },
    houseProfit: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// 인덱스 추가
GameHistorySchema.index({ gameType: 1, endTime: -1 });
GameHistorySchema.index({ roomId: 1, endTime: -1 });
GameHistorySchema.index({ "players.user": 1, endTime: -1 });

module.exports = mongoose.model("GameHistory", GameHistorySchema);
