const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/user.model");
const ExchangeRequest = require("../models/exchangeRequest.model");
const DepositRequest = require("../models/depositRequest.model");
const Transfer = require("../models/transfer.model");
const MoneyRequest = require("../models/moneyRequest.model");
const auth = require("../middleware/auth.middleware");
const {
  updateAndBroadcastLeaderboard,
} = require("../services/leaderboard.service");

const router = express.Router();

// This module exports a function that takes io and userSockets
module.exports = (io, userSockets) => {
  // Exchange request
  router.post("/exchange/request", auth(), async (req, res) => {
    const { amount } = req.body;
    try {
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }
      if (amount < 5000) {
        return res
          .status(400)
          .json({ message: "최소 5,000원부터 환전 가능합니다." });
      }
      if (user.balance < amount) {
        return res.status(400).json({ message: "보유 잔액이 부족합니다." });
      }
      const rollingDeposit = user.rollingDeposit || 0;
      const rollingWagered = user.rollingWagered || 0;
      const rollingRequirement = rollingDeposit * 1.5;
      const maxExchangeAmount =
        rollingWagered >= rollingRequirement ? user.balance : 0;
      if (amount > maxExchangeAmount) {
        return res.status(400).json({
          message: `환전 가능 금액을 초과했습니다. 최대 환전 가능: ${maxExchangeAmount.toLocaleString()}원`,
        });
      }
      const fee = Math.floor(amount * 0.1);
      const actualAmount = amount - fee;
      user.balance -= amount;
      await user.save();
      const exchangeRequest = new ExchangeRequest({
        userId: user._id,
        username: user.username,
        requestAmount: amount,
        actualAmount: actualAmount,
        fee,
        rollingPoint: user.rollingWagered || 0,
      });
      await exchangeRequest.save();
      const userSocket = userSockets.get(user._id.toString());
      if (userSocket) {
        userSocket.emit("balance_updated", {
          newBalance: user.balance,
          reason: "exchange_request",
        });
      }
      io.emit("new_exchange_request", {
        username: user.username,
        requestAmount: amount,
        actualAmount: actualAmount,
        fee,
        createdAt: exchangeRequest.createdAt,
      });
      await updateAndBroadcastLeaderboard();
      res.json({
        message: "환전 신청이 완료되었습니다. 관리자 승인을 기다려주세요.",
        newBalance: user.balance,
      });
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  // User's exchange history
  router.get("/exchange/history", auth(), async (req, res) => {
    try {
      const exchanges = await ExchangeRequest.find({ userId: req.user.id })
        .sort({ createdAt: -1 })
        .lean();
      res.json(exchanges);
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  // Deposit request
  router.post("/deposit/request", auth(), async (req, res) => {
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

  // User's deposit history
  router.get("/deposit/history", auth(), async (req, res) => {
    try {
      const deposits = await DepositRequest.find({ userId: req.user.id })
        .sort({ createdAt: -1 })
        .lean();
      res.json(deposits);
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  // Send money
  router.post("/transfer/send", auth(), async (req, res) => {
    const { toUserId, amount } = req.body;
    try {
      if (!toUserId || !amount || amount < 1000) {
        return res.status(400).json({
          message: "올바른 송금 정보를 입력해주세요. (최소 1,000원)",
        });
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
      fromUser.balance -= totalAmount;
      toUser.balance += amount;
      await fromUser.save();
      await toUser.save();
      const sentTransfer = new Transfer({
        fromUserId: fromUser._id,
        toUserId: toUser._id,
        amount,
        fee,
        type: "sent",
      });
      await sentTransfer.save();
      const receivedTransfer = new Transfer({
        fromUserId: fromUser._id,
        toUserId: toUser._id,
        amount,
        fee: 0,
        type: "received",
      });
      await receivedTransfer.save();
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
          reason: "money_received",
        });
        toUserSocket.emit("transfer_history_updated");
      }
      const fromUserSocket = userSockets.get(fromUser._id.toString());
      if (fromUserSocket) {
        fromUserSocket.emit("money_sent", {
          toUserId: toUser._id.toString(),
          toUsername: toUser.username,
          amount,
          fee,
          timestamp: new Date(),
        });
        fromUserSocket.emit("transfer_history_updated");
      }
      await updateAndBroadcastLeaderboard();
      res.json({
        message: "송금이 완료되었습니다.",
        newBalance: fromUser.balance,
      });
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  // Request money
  router.post("/transfer/request", auth(), async (req, res) => {
    const { fromUserId, amount, message } = req.body;
    try {
      if (!fromUserId || !amount || amount < 1000) {
        return res
          .status(400)
          .json({ message: "올바른 요청 정보를 입력해주세요. (최소 1,000원)" });
      }
      const toUser = await User.findById(req.user.id);
      const fromUser = await User.findById(fromUserId);
      if (!toUser || !fromUser) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }
      if (toUser._id.toString() === fromUser._id.toString()) {
        return res
          .status(400)
          .json({ message: "자기 자신에게 요청할 수 없습니다." });
      }
      const moneyRequest = new MoneyRequest({
        fromUserId: req.user.id,
        toUserId: fromUserId,
        amount,
        message: message || "",
      });
      await moneyRequest.save();
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
        fromUserSocket.emit("received_requests_updated");
      }
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

  // Get received money requests
  router.get("/transfer/requests/received", auth(), async (req, res) => {
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

  // Accept money request
  router.post(
    "/transfer/request/:requestId/accept",
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
        const fromUser = await User.findById(request.toUserId);
        const toUser = await User.findById(request.fromUserId);
        if (!fromUser || !toUser) {
          return res
            .status(404)
            .json({ message: "사용자를 찾을 수 없습니다." });
        }
        const fee = Math.floor(request.amount * 0.05);
        const totalAmount = request.amount + fee;
        if (fromUser.balance < totalAmount) {
          return res.status(400).json({ message: "잔액이 부족합니다." });
        }
        fromUser.balance -= totalAmount;
        toUser.balance += request.amount;
        await fromUser.save();
        await toUser.save();
        request.status = "accepted";
        await request.save();
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
            reason: "money_request_accepted",
          });
          toUserSocket.emit("transfer_history_updated");
        }
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
          fromUserSocket.emit("transfer_history_updated");
          fromUserSocket.emit("received_requests_updated");
        }
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

  // Reject money request
  router.post(
    "/transfer/request/:requestId/reject",
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
        request.status = "rejected";
        await request.save();
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
        const toUserSocket = userSockets.get(req.user.id);
        if (toUserSocket) {
          toUserSocket.emit("money_request_reject_completed", {
            requestId: request._id.toString(),
            fromUserId: request.fromUserId.toString(),
            fromUsername: fromUser.username,
            amount: request.amount,
            timestamp: new Date(),
          });
          toUserSocket.emit("received_requests_updated");
        }
        res.json({ message: "요청을 거절했습니다." });
      } catch (err) {
        res.status(500).json({ message: "서버 에러" });
      }
    }
  );

  // Get transfer history
  router.get("/transfer/history", auth(), async (req, res) => {
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

  return router;
};
