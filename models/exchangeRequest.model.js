const mongoose = require("mongoose");

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

module.exports = mongoose.model("ExchangeRequest", exchangeRequestSchema);
