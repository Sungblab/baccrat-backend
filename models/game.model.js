const mongoose = require("mongoose");

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
      bettor_count: { type: Number, default: 0 },
      total_bet_amount: { type: Number, default: 0 },
    },
    banker: {
      count: { type: Number, default: 0 },
      total: { type: Number, default: 0 }, // 원 단위 총 베팅액
      bettor_count: { type: Number, default: 0 },
      total_bet_amount: { type: Number, default: 0 },
    },
    tie: {
      count: { type: Number, default: 0 },
      total: { type: Number, default: 0 }, // 원 단위 총 베팅액
      bettor_count: { type: Number, default: 0 },
      total_bet_amount: { type: Number, default: 0 },
    },
    player_pair: {
      // 플레이어 페어 통계 추가
      count: { type: Number, default: 0 },
      total: { type: Number, default: 0 }, // 원 단위 총 베팅액
      bettor_count: { type: Number, default: 0 },
      total_bet_amount: { type: Number, default: 0 },
    },
    banker_pair: {
      // 뱅커 페어 통계 추가
      count: { type: Number, default: 0 },
      total: { type: Number, default: 0 }, // 원 단위 총 베팅액
      bettor_count: { type: Number, default: 0 },
      total_bet_amount: { type: Number, default: 0 },
    },
  },
  totalBets: { type: Number, default: 0 }, // 원 단위 총 베팅액
  playerCount: { type: Number, default: 0 },
});

// The original schema was missing some fields in `stats` that are used in the code. I've added them.

module.exports = mongoose.model("Game", gameSchema);
