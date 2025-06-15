const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
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
    enum: ["user", "admin", "superadmin"],
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
  createdAt: { type: Date, default: Date.now }, // 가입일 추가
  lastLogin: { type: Date }, // 마지막 로그인
});

// 한글 지원을 위한 스키마 옵션 설정
userSchema.set("toJSON", {
  transform: function (doc, ret) {
    // 한글 문자가 제대로 인코딩되도록 보장
    if (ret.username) {
      ret.username = ret.username.toString();
    }
    return ret;
  },
});

// `role` enum에 'superadmin'이 사용되고 있어서 추가했습니다.
// `createdAt`과 `lastLogin` 필드가 `user` 객체에서 사용되고 있어서 추가했습니다.

module.exports = mongoose.model("User", userSchema);
