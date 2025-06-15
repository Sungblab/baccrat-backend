const express = require("express");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Game = require("../models/game.model");
const DepositRequest = require("../models/depositRequest.model");
const ExchangeRequest = require("../models/exchangeRequest.model");
const Chat = require("../models/chat.model");
const auth = require("../middleware/auth.middleware");
const { calculateProfit } = require("../utils/helpers");
const {
  generateLeaderboardData,
  updateAndBroadcastLeaderboard,
} = require("../services/leaderboard.service");

const router = express.Router();

module.exports = (io, userSockets) => {
  // Routes
  router.get("/users", auth("admin"), async (req, res) => {
    try {
      const users = await User.find().select("-password");
      res.json(users);
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  router.get("/users-stats", auth("admin"), async (req, res) => {
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
          netProfit: netProfit,
        };
      });

      res.json(stats);
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  router.get("/user-detail/:userId", auth("admin"), async (req, res) => {
    try {
      const user = await User.findById(req.params.userId)
        .select("-password")
        .lean();
      if (!user) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }

      // 바카라 베팅 기록 (기존 bettingHistory)
      const baccaratHistory = user.bettingHistory || [];
      const baccaratWins = baccaratHistory.filter(
        (bet) => bet.result === "win"
      ).length;
      const baccaratLosses = baccaratHistory.filter(
        (bet) => bet.result === "lose"
      ).length;
      const baccaratTotalGames = baccaratHistory.length;
      const baccaratWinRate =
        baccaratTotalGames > 0
          ? ((baccaratWins / baccaratTotalGames) * 100).toFixed(1)
          : 0;

      let baccaratTotalBetAmount = 0;
      let baccaratTotalWinAmount = 0;
      let baccaratBettingProfit = 0;

      baccaratHistory.forEach((bet) => {
        baccaratTotalBetAmount += bet.amount || 0;
        if (bet.result === "win") {
          const profit = calculateProfit(bet);
          baccaratTotalWinAmount += (bet.amount || 0) + profit;
          baccaratBettingProfit += profit;
        } else if (bet.result === "lose") {
          baccaratBettingProfit -= bet.amount || 0;
        }
      });

      // 블랙잭 통계 가져오기
      const { BlackjackGame } = require("../models/blackjack.model");
      let blackjackStats = {
        totalGames: 0,
        wins: 0,
        losses: 0,
        totalBetAmount: 0,
        totalWinAmount: 0,
        bettingProfit: 0,
        winRate: 0,
        blackjacks: 0,
        busts: 0,
        recentGames: [],
      };

      try {
        const blackjackGames = await BlackjackGame.find({
          "players.userId": req.params.userId,
          gameEndTime: { $exists: true },
        })
          .sort({ gameEndTime: -1 })
          .limit(50)
          .lean();

        if (blackjackGames.length > 0) {
          blackjackStats.totalGames = blackjackGames.length;

          blackjackGames.forEach((game) => {
            const player = game.players.find(
              (p) => p.userId.toString() === req.params.userId
            );
            if (player) {
              blackjackStats.totalBetAmount += player.betAmount || 0;
              blackjackStats.totalWinAmount += player.payout || 0;
              blackjackStats.bettingProfit +=
                (player.payout || 0) - (player.betAmount || 0);

              if (player.result === "win" || player.result === "blackjack") {
                blackjackStats.wins++;
              } else if (player.result === "lose" || player.result === "bust") {
                blackjackStats.losses++;
              }

              if (player.result === "blackjack") {
                blackjackStats.blackjacks++;
              }
              if (player.result === "bust") {
                blackjackStats.busts++;
              }
            }
          });

          blackjackStats.winRate =
            blackjackStats.totalGames > 0
              ? (
                  (blackjackStats.wins / blackjackStats.totalGames) *
                  100
                ).toFixed(1)
              : 0;

          // 최근 블랙잭 게임 기록
          blackjackStats.recentGames = blackjackGames
            .slice(0, 10)
            .map((game) => {
              const player = game.players.find(
                (p) => p.userId.toString() === req.params.userId
              );
              return {
                gameId: game._id,
                roomName: game.roomName,
                result: player ? player.result : "unknown",
                betAmount: player ? player.betAmount : 0,
                payout: player ? player.payout : 0,
                playerScore: player ? player.score : 0,
                dealerScore: game.dealerScore,
                gameEndTime: game.gameEndTime,
                createdAt: game.createdAt,
              };
            });
        }
      } catch (blackjackError) {
        console.error("블랙잭 통계 조회 오류:", blackjackError);
      }

      // 통합 통계
      const totalGames = baccaratTotalGames + blackjackStats.totalGames;
      const totalWins = baccaratWins + blackjackStats.wins;
      const totalLosses = baccaratLosses + blackjackStats.losses;
      const overallWinRate =
        totalGames > 0 ? ((totalWins / totalGames) * 100).toFixed(1) : 0;
      const totalBetAmount =
        baccaratTotalBetAmount + blackjackStats.totalBetAmount;
      const totalWinAmount =
        baccaratTotalWinAmount + blackjackStats.totalWinAmount;
      const totalBettingProfit =
        baccaratBettingProfit + blackjackStats.bettingProfit;

      // 재정 정보
      const deposits = await DepositRequest.find({ userId: req.params.userId })
        .sort({ createdAt: -1 })
        .lean();
      const totalDeposited = deposits
        .filter((d) => d.status === "approved")
        .reduce((sum, d) => sum + (d.amount || 0), 0);

      const exchanges = await ExchangeRequest.find({
        userId: req.params.userId,
      })
        .sort({ createdAt: -1 })
        .lean();
      const totalExchanged = exchanges
        .filter((e) => e.status === "approved")
        .reduce((sum, e) => sum + (e.actualAmount || 0), 0);

      const overallProfit = user.balance + totalExchanged - totalDeposited;

      // 롤링 정보
      const rollingDeposit = user.rollingDeposit || 0;
      const rollingWagered = user.rollingWagered || 0;
      const rollingRequirement = rollingDeposit * 1.5;
      const rollingProgress =
        rollingRequirement > 0
          ? Math.min(100, (rollingWagered / rollingRequirement) * 100)
          : 100;

      // 바카라 선택 통계
      const choiceStats = {
        player: baccaratHistory.filter((bet) => bet.choice === "player").length,
        banker: baccaratHistory.filter((bet) => bet.choice === "banker").length,
        tie: baccaratHistory.filter((bet) => bet.choice === "tie").length,
        player_pair: baccaratHistory.filter(
          (bet) => bet.choice === "player_pair"
        ).length,
        banker_pair: baccaratHistory.filter(
          (bet) => bet.choice === "banker_pair"
        ).length,
      };

      const favoriteChoice = Object.entries(choiceStats).sort(
        ([, a], [, b]) => b - a
      )[0];

      // 최근 게임 활동 (바카라 + 블랙잭)
      const recentBaccaratGames = baccaratHistory
        .slice(-10)
        .reverse()
        .map((bet) => ({
          type: "baccarat",
          choice: bet.choice,
          amount: bet.amount,
          result: bet.result,
          gameResult: bet.gameResult,
          date: bet.date,
          profit:
            bet.result === "win" ? calculateProfit(bet) : -(bet.amount || 0),
        }));

      const recentActivity = [
        ...recentBaccaratGames,
        ...blackjackStats.recentGames.map((game) => ({
          type: "blackjack",
          roomName: game.roomName,
          amount: game.betAmount,
          result: game.result,
          playerScore: game.playerScore,
          dealerScore: game.dealerScore,
          date: game.gameEndTime || game.createdAt,
          profit: game.payout - game.betAmount,
        })),
      ]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 15);

      res.json({
        _id: user._id,
        username: user.username,
        balance: user.balance,
        role: user.role,
        isApproved: user.isApproved,
        createdAt: user.createdAt,

        // 통합 통계
        totalGames,
        totalWins,
        totalLosses,
        overallWinRate: parseFloat(overallWinRate),
        totalBetAmount,
        totalWinAmount,
        totalBettingProfit,
        averageBetAmount:
          totalGames > 0 ? Math.round(totalBetAmount / totalGames) : 0,

        // 바카라 통계
        baccarat: {
          totalGames: baccaratTotalGames,
          wins: baccaratWins,
          losses: baccaratLosses,
          winRate: parseFloat(baccaratWinRate),
          totalBetAmount: baccaratTotalBetAmount,
          totalWinAmount: baccaratTotalWinAmount,
          bettingProfit: baccaratBettingProfit,
          averageBetAmount:
            baccaratTotalGames > 0
              ? Math.round(baccaratTotalBetAmount / baccaratTotalGames)
              : 0,
          choiceStats,
          favoriteChoice: favoriteChoice
            ? {
                choice: favoriteChoice[0],
                count: favoriteChoice[1],
              }
            : null,
        },

        // 블랙잭 통계
        blackjack: {
          totalGames: blackjackStats.totalGames,
          wins: blackjackStats.wins,
          losses: blackjackStats.losses,
          winRate: parseFloat(blackjackStats.winRate),
          totalBetAmount: blackjackStats.totalBetAmount,
          totalWinAmount: blackjackStats.totalWinAmount,
          bettingProfit: blackjackStats.bettingProfit,
          averageBetAmount:
            blackjackStats.totalGames > 0
              ? Math.round(
                  blackjackStats.totalBetAmount / blackjackStats.totalGames
                )
              : 0,
          blackjacks: blackjackStats.blackjacks,
          busts: blackjackStats.busts,
        },

        // 재정 정보
        totalDeposited,
        totalExchanged,
        overallProfit,
        depositCount: deposits.filter((d) => d.status === "approved").length,
        exchangeCount: exchanges.filter((e) => e.status === "approved").length,

        // 롤링 정보
        rollingDeposit,
        rollingWagered,
        rollingRequirement,
        rollingProgress: parseFloat(rollingProgress.toFixed(1)),

        // 최근 활동
        recentActivity,

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

  router.get("/leaderboard", auth("admin"), async (req, res) => {
    try {
      const leaderboard = await generateLeaderboardData();
      res.json(leaderboard);
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  router.delete("/users/:id", auth("admin"), async (req, res) => {
    try {
      const user = await User.findById(req.params.id);

      if (!user) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }
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

  router.put("/users/:id/reset-password", auth("admin"), async (req, res) => {
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
  });

  router.put("/users/:id/approve", auth("admin"), async (req, res) => {
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

  router.put("/users/:id/adjust-coins", auth("admin"), async (req, res) => {
    const { adjustment } = req.body;
    try {
      const user = await User.findById(req.params.id);
      if (!user) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }

      user.balance += parseInt(adjustment);
      if (user.balance < 0) user.balance = 0;
      await user.save();

      const userSocket = userSockets.get(user._id.toString());
      if (userSocket) {
        userSocket.emit("balance_updated", {
          newBalance: user.balance,
          reason: "admin_adjustment",
          adjustment: parseInt(adjustment),
        });
      }

      io.emit("user_balance_updated", {
        userId: user._id.toString(),
        newBalance: user.balance,
      });

      await updateAndBroadcastLeaderboard();

      res.json({
        message: `잔액이 조정되었습니다. 현재 잔액: ${user.balance}`,
        balance: user.balance,
        newBalance: user.balance,
      });
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  router.get("/all-betting-history", auth("admin"), async (req, res) => {
    try {
      const users = await User.find()
        .select("username bettingHistory")
        .sort({ "bettingHistory.date": -1 })
        .lean();

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

      allBets.sort((a, b) => new Date(b.date) - new Date(a.date));
      allBets = allBets.slice(0, 100);

      res.json(allBets);
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  router.get("/recent-games", auth("admin"), async (req, res) => {
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

  router.put("/users/:id/toggle-admin", auth("admin"), async (req, res) => {
    try {
      const { setAdmin } = req.body;
      const user = await User.findById(req.params.id);

      if (!user) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }
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
  });

  router.delete("/reset-game-history", auth("admin"), async (req, res) => {
    try {
      await Game.deleteMany({});
      res.json({ message: "게임 기록이 초기화되었습니다." });
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  router.get("/exchange-requests", auth("admin"), async (req, res) => {
    try {
      const requests = await ExchangeRequest.find()
        .sort({ createdAt: -1 })
        .lean();
      res.json(requests);
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  router.put("/exchange-requests/:id", auth("admin"), async (req, res) => {
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
        request.status = "rejected";
        await request.save();
        return res
          .status(404)
          .json({ message: "사용자를 찾을 수 없어 요청을 거절 처리합니다." });
      }
      if (status === "rejected") {
        user.balance += request.requestAmount;
        await user.save();
      }
      request.status = status;
      await request.save();
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
          userSocket.emit("balance_updated", {
            newBalance: user.balance,
            reason: "exchange_rejected",
          });
          userSocket.emit("exchange_request_processed", {
            status: "rejected",
            requestAmount: request.requestAmount,
            actualAmount: request.actualAmount,
            newBalance: user.balance,
          });
        }
      }
      io.emit("user_balance_updated", {
        userId: user._id.toString(),
        newBalance: user.balance,
      });
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

  router.get("/users-financial-summary", auth("admin"), async (req, res) => {
    try {
      const users = await User.find().select("-password").lean();
      const depositsCollection =
        mongoose.connection.db.collection("depositrequests");
      const exchangeRequestsCollection =
        mongoose.connection.db.collection("exchangerequests");
      const summaries = [];
      for (const user of users) {
        const approvedDeposits = await depositsCollection
          .find({
            userId: new mongoose.Types.ObjectId(user._id),
            status: "approved",
          })
          .toArray();
        const totalDeposited = approvedDeposits.reduce(
          (sum, dep) => sum + (dep.amount || 0),
          0
        );
        const approvedExchanges = await exchangeRequestsCollection
          .find({
            userId: new mongoose.Types.ObjectId(user._id),
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
      summaries.sort((a, b) => b.financialProfit - a.financialProfit);
      res.json(summaries);
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  router.get("/deposit-requests", auth("admin"), async (req, res) => {
    try {
      const requests = await DepositRequest.find()
        .sort({ createdAt: -1 })
        .lean();
      res.json(requests);
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  router.put("/deposit-requests/:id", auth("admin"), async (req, res) => {
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
        request.status = "rejected";
        await request.save();
        return res.status(404).json({
          message: "사용자를 찾을 수 없어 요청을 거절 처리합니다.",
        });
      }
      request.status = status;
      await request.save();
      if (status === "approved") {
        user.balance += request.amount;
        user.rollingDeposit = request.amount;
        user.rollingWagered = 0;
        await user.save();
        const userSocket = userSockets.get(user._id.toString());
        if (userSocket) {
          userSocket.emit("balance_updated", {
            newBalance: user.balance,
            reason: "deposit_approved",
          });
          userSocket.emit("deposit_request_processed", {
            status: "approved",
            amount: request.amount,
            newBalance: user.balance,
          });
        }
        io.emit("user_balance_updated", {
          userId: user._id.toString(),
          newBalance: user.balance,
        });
        await updateAndBroadcastLeaderboard();
      } else {
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

  router.delete("/chat/message/:messageId", auth("admin"), async (req, res) => {
    try {
      const { messageId } = req.params;

      const deletedMessage = await Chat.findByIdAndDelete(messageId);
      if (!deletedMessage) {
        return res.status(404).json({ message: "메시지를 찾을 수 없습니다." });
      }

      io.emit("chat_message_deleted", { messageId });

      res.json({ message: "메시지가 삭제되었습니다." });
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  // 하우스 손익 통계 API
  router.get("/house-stats", auth("admin"), async (req, res) => {
    try {
      const { BlackjackGame } = require("../models/blackjack.model");

      // 바카라 게임 통계 (User의 bettingHistory에서 계산)
      const users = await User.find().select("bettingHistory").lean();
      let baccaratStats = {
        totalBets: 0,
        totalPayouts: 0,
        totalGames: 0,
        houseProfit: 0,
      };

      let totalPlayerProfit = 0;

      users.forEach((user) => {
        if (user.bettingHistory) {
          user.bettingHistory.forEach((bet) => {
            // 바카라 베팅 계산
            baccaratStats.totalGames++;
            baccaratStats.totalBets += bet.amount || 0;

            const profit = calculateProfit(bet);
            totalPlayerProfit += profit;

            if (bet.result === "win") {
              const payout = (bet.amount || 0) + profit;
              baccaratStats.totalPayouts += payout;
              baccaratStats.houseProfit -= profit; // 플레이어가 이긴 만큼 하우스는 손실
            } else if (bet.result === "lose") {
              baccaratStats.houseProfit += bet.amount || 0; // 플레이어가 잃은 만큼 하우스는 수익
            }
            // tie의 경우 베팅금이 그대로 돌아가므로 하우스 수익에 영향 없음
          });
        }
      });

      // 블랙잭 게임 통계
      const blackjackGameStats = await BlackjackGame.aggregate([
        { $match: { gameEndTime: { $exists: true } } },
        {
          $group: {
            _id: null,
            totalBets: { $sum: "$totalBets" },
            totalPayouts: { $sum: "$totalPayouts" },
            totalGames: { $sum: 1 },
            houseProfit: { $sum: "$houseProfit" },
          },
        },
      ]);

      const blackjack = blackjackGameStats[0] || {
        totalBets: 0,
        totalPayouts: 0,
        totalGames: 0,
        houseProfit: 0,
      };

      // 충전/환전 정보
      const totalDeposits = await DepositRequest.aggregate([
        { $match: { status: "approved" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);

      const totalExchanges = await ExchangeRequest.aggregate([
        { $match: { status: "approved" } },
        { $group: { _id: null, total: { $sum: "$actualAmount" } } },
      ]);

      const totalHouseProfit =
        baccaratStats.houseProfit + blackjack.houseProfit;
      const totalBets = baccaratStats.totalBets + blackjack.totalBets;
      const totalPayouts = baccaratStats.totalPayouts + blackjack.totalPayouts;
      const totalGames = baccaratStats.totalGames + blackjack.totalGames;

      const totalDepositAmount = totalDeposits[0]?.total || 0;
      const totalExchangeAmount = totalExchanges[0]?.total || 0;

      // 실제 하우스 수익 = 총 충전액 - 총 환전액 (플레이어가 실제로 입금/출금한 금액 기준)
      const realHouseProfit = totalDepositAmount - totalExchangeAmount;

      res.json({
        baccarat: {
          totalBets: baccaratStats.totalBets,
          totalPayouts: baccaratStats.totalPayouts,
          totalGames: baccaratStats.totalGames,
          houseProfit: baccaratStats.houseProfit,
        },
        blackjack: {
          totalBets: blackjack.totalBets,
          totalPayouts: blackjack.totalPayouts,
          totalGames: blackjack.totalGames,
          houseProfit: blackjack.houseProfit,
        },
        total: {
          totalBets,
          totalPayouts,
          totalGames,
          gameBasedHouseProfit: totalHouseProfit, // 게임 베팅 기준 하우스 수익
          realHouseProfit, // 실제 충전-환전 기준 수익
          totalDeposits: totalDepositAmount,
          totalExchanges: totalExchangeAmount,
          totalPlayerProfit: totalPlayerProfit,
        },
      });
    } catch (err) {
      console.error("House stats error:", err);
      res.status(500).json({ message: "서버 에러" });
    }
  });

  return router;
};
