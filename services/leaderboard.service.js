const User = require("../models/user.model");

let io;

function initializeLeaderboardService(socketIoInstance) {
  io = socketIoInstance;
}

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

    leaderboard.sort((a, b) => b.balance - a.balance);
    return leaderboard;
  } catch (err) {
    console.error("리더보드 데이터 생성 오류:", err);
    return [];
  }
}

async function updateAndBroadcastLeaderboard() {
  try {
    if (!io) {
      console.error("Leaderboard service not initialized with io.");
      return;
    }
    const leaderboard = await generateLeaderboardData();
    io.emit("leaderboard_updated", leaderboard);
  } catch (err) {
    console.error("리더보드 브로드캐스트 오류:", err);
  }
}

module.exports = {
  initializeLeaderboardService,
  generateLeaderboardData,
  updateAndBroadcastLeaderboard,
};
