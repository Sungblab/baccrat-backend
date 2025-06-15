const express = require("express");
const User = require("../models/user.model");
const DepositRequest = require("../models/depositRequest.model");
const ExchangeRequest = require("../models/exchangeRequest.model");
const auth = require("../middleware/auth.middleware");
const { calculateProfit } = require("../utils/helpers");

const router = express.Router();

// Get detailed user info for "My Page"
router.get("/detailed-info", auth(), async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password").lean();
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    const bettingHistory = user.bettingHistory || [];
    const wins = bettingHistory.filter((bet) => bet.result === "win").length;
    const losses = bettingHistory.filter((bet) => bet.result === "lose").length;
    const totalGames = bettingHistory.length;
    const winRate = totalGames > 0 ? ((wins / totalGames) * 100).toFixed(1) : 0;

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

    const deposits = await DepositRequest.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    const totalDeposited = deposits
      .filter((d) => d.status === "approved")
      .reduce((sum, d) => sum + (d.amount || 0), 0);

    const exchanges = await ExchangeRequest.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();
    const totalExchanged = exchanges
      .filter((e) => e.status === "approved")
      .reduce((sum, e) => sum + (e.actualAmount || 0), 0);

    const overallProfit = user.balance + totalExchanged - totalDeposited;

    const rollingRequirement = (user.rollingDeposit || 0) * 1.5;
    const rollingWagered = user.rollingWagered || 0;
    const rollingProgress =
      rollingRequirement > 0
        ? Math.min(100, (rollingWagered / rollingRequirement) * 100)
        : 100;

    const maxExchangeAmount = Math.min(user.balance, rollingWagered);
    const recentBets = bettingHistory.slice(-20).reverse();

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
      username: user.username,
      balance: user.balance,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      isApproved: user.isApproved,
      role: user.role,
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
      bettingStats: {
        totalBetAmount,
        totalWinAmount,
        bettingProfit,
        averageBetAmount:
          totalGames > 0 ? Math.round(totalBetAmount / totalGames) : 0,
      },
      financialInfo: {
        totalDeposited,
        totalExchanged,
        overallProfit,
        depositCount: deposits.filter((d) => d.status === "approved").length,
        exchangeCount: exchanges.filter((e) => e.status === "approved").length,
      },
      rollingInfo: {
        rollingDeposit: user.rollingDeposit || 0,
        rollingWagered: rollingWagered,
        rollingRequirement,
        rollingProgress: parseFloat(rollingProgress.toFixed(1)),
        maxExchangeAmount,
      },
      recentBets,
      recentDeposits: deposits.slice(0, 5),
      recentExchanges: exchanges.slice(0, 5),
      choiceStats,
    });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// Get list of users (excluding self) for transfers
router.get("/list", auth(), async (req, res) => {
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

module.exports = router;
