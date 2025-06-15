const {
  BlackjackGame,
  BlackjackPlayerStats,
} = require("../models/blackjack.model");
const User = require("../models/user.model");

class BlackjackStatsService {
  constructor() {
    this.playerStatsCache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5분 캐시
  }

  // 게임 결과 저장 (1대1 게임용)
  async saveGameResult(
    sessionId,
    sessionName,
    gameStartTime,
    dealerData,
    playersData
  ) {
    try {
      const totalBets = playersData.reduce(
        (sum, player) => sum + player.betAmount,
        0
      );
      const totalPayouts = playersData.reduce(
        (sum, player) => sum + player.payout,
        0
      );
      const houseProfit = totalBets - totalPayouts;

      // 게임 기록 저장 (1대1이므로 sessionId를 roomId로 사용)
      const gameRecord = new BlackjackGame({
        roomId: sessionId, // 세션 ID를 방 ID로 사용
        roomName: sessionName, // 세션 이름을 방 이름으로 사용
        gameStartTime,
        gameEndTime: new Date(),
        dealerCards: dealerData.cards,
        dealerScore: dealerData.score,
        dealerBusted: dealerData.isBusted,
        players: playersData,
        totalBets,
        totalPayouts,
        houseProfit,
      });

      await gameRecord.save();

      // 플레이어 통계 업데이트 (1대1이므로 1명만)
      if (playersData.length > 0) {
        await this.updatePlayerStats(playersData[0]);
      }
      return gameRecord;
    } catch (error) {
      console.error("게임 결과 저장 오류:", error);
      throw error;
    }
  }

  // 플레이어 통계 업데이트
  async updatePlayerStats(playerData) {
    try {
      const {
        userId,
        username,
        betAmount,
        result,
        payout,
        isBlackjack,
        isBusted,
        hasDoubled,
        insurance,
      } = playerData;

      let stats = await BlackjackPlayerStats.findOne({ userId });

      if (!stats) {
        stats = new BlackjackPlayerStats({
          userId,
          username,
        });
      }

      // 기본 통계 업데이트
      stats.totalGames += 1;
      stats.totalBets += betAmount;
      stats.totalWinnings += payout;
      stats.totalProfit += payout - betAmount;
      stats.lastPlayedAt = new Date();

      // 결과별 통계
      if (result === "win" || result === "blackjack") {
        stats.wins += 1;
        stats.currentWinStreak += 1;
        stats.currentLoseStreak = 0;
        stats.bestWinStreak = Math.max(
          stats.bestWinStreak,
          stats.currentWinStreak
        );
      } else if (result === "lose" || result === "bust") {
        stats.losses += 1;
        stats.currentLoseStreak += 1;
        stats.currentWinStreak = 0;
        stats.bestLoseStreak = Math.max(
          stats.bestLoseStreak,
          stats.currentLoseStreak
        );
      } else if (result === "push") {
        stats.pushes += 1;
        stats.currentWinStreak = 0;
        stats.currentLoseStreak = 0;
      }

      if (isBlackjack) {
        stats.blackjacks += 1;
      }

      if (isBusted) {
        stats.busts += 1;
      }

      if (hasDoubled) {
        stats.handsDoubled += 1;
      }

      if (insurance > 0) {
        stats.insuranceTaken += 1;
      }

      // 승률 계산
      const totalDecisiveGames = stats.wins + stats.losses;
      stats.winRate =
        totalDecisiveGames > 0 ? (stats.wins / totalDecisiveGames) * 100 : 0;

      // 평균 베팅 크기
      stats.avgBetSize =
        stats.totalGames > 0 ? stats.totalBets / stats.totalGames : 0;

      // 월별 통계 업데이트
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;

      let monthlyStats = stats.monthlyStats.find(
        (ms) => ms.year === currentYear && ms.month === currentMonth
      );
      if (!monthlyStats) {
        monthlyStats = {
          year: currentYear,
          month: currentMonth,
          games: 0,
          wins: 0,
          losses: 0,
          profit: 0,
          totalBets: 0,
        };
        stats.monthlyStats.push(monthlyStats);
      }

      monthlyStats.games += 1;
      monthlyStats.totalBets += betAmount;
      monthlyStats.profit += payout - betAmount;

      if (result === "win" || result === "blackjack") {
        monthlyStats.wins += 1;
      } else if (result === "lose" || result === "bust") {
        monthlyStats.losses += 1;
      }

      await stats.save();

      // 캐시 무효화
      this.playerStatsCache.delete(userId.toString());
    } catch (error) {
      throw error;
    }
  }

  // 리더보드 조회
  async getLeaderboard(sortBy = "winRate", limit = 50) {
    try {
      let sortCriteria = {};

      switch (sortBy) {
        case "winRate":
          sortCriteria = { winRate: -1, totalGames: -1 };
          break;
        case "totalGames":
          sortCriteria = { totalGames: -1 };
          break;
        case "totalProfit":
          sortCriteria = { totalProfit: -1 };
          break;
        case "totalBets":
          sortCriteria = { totalBets: -1 };
          break;
        case "blackjacks":
          sortCriteria = { blackjacks: -1 };
          break;
        case "balance":
          sortCriteria = { "userInfo.balance": -1 };
          break;
        default:
          sortCriteria = { winRate: -1, totalGames: -1 };
      }

      // 사용자 정보와 조인하여 현재 잔액 정보 포함
      const leaderboard = await BlackjackPlayerStats.aggregate([
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "userInfo",
          },
        },
        {
          $unwind: "$userInfo",
        },
        {
          $addFields: {
            balance: "$userInfo.balance",
            isOnline: false, // 온라인 상태는 별도로 처리
            currentSession: null, // 현재 세션 정보는 별도로 처리
          },
        },
        {
          $match: {
            totalGames: { $gt: 0 }, // 최소 1게임 이상 플레이한 사용자만
          },
        },
        {
          $sort: sortCriteria,
        },
        {
          $limit: limit,
        },
        {
          $project: {
            userId: 1,
            username: 1,
            totalGames: 1,
            wins: 1,
            losses: 1,
            pushes: 1,
            blackjacks: 1,
            busts: 1,
            totalBets: 1,
            totalWinnings: 1,
            totalProfit: 1,
            winRate: 1,
            avgBetSize: 1,
            bestWinStreak: 1,
            currentWinStreak: 1,
            bestLoseStreak: 1,
            currentLoseStreak: 1,
            handsDoubled: 1,
            insuranceTaken: 1,
            lastPlayedAt: 1,
            balance: 1,
            isOnline: 1,
            currentSession: 1,
            maxWinStreak: "$bestWinStreak", // 호환성을 위해 별칭 추가
          },
        },
      ]);

      return leaderboard;
    } catch (error) {
      console.error("리더보드 조회 오류:", error);
      throw error;
    }
  }

  // 플레이어 상세 통계 조회
  async getPlayerStats(userId) {
    try {
      const cacheKey = userId.toString();
      const cached = this.playerStatsCache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }

      const stats = await BlackjackPlayerStats.findOne({ userId }).populate(
        "userId",
        "username balance"
      );

      if (!stats) {
        return null;
      }

      // 최근 게임 기록 조회 (1대1 게임용으로 수정)
      const recentGames = await BlackjackGame.find(
        { "players.userId": userId },
        {
          roomName: 1, // 이제 세션 이름
          gameEndTime: 1,
          players: { $elemMatch: { userId } },
          dealerScore: 1,
          dealerBusted: 1,
        }
      )
        .sort({ gameEndTime: -1 })
        .limit(10);

      const result = {
        ...stats.toObject(),
        recentGames: recentGames.map((game) => ({
          sessionName: game.roomName, // 세션 이름으로 변경
          gameTime: game.gameEndTime,
          result: game.players[0].result,
          betAmount: game.players[0].betAmount,
          payout: game.players[0].payout,
          playerScore: game.players[0].score,
          dealerScore: game.dealerScore,
          dealerBusted: game.dealerBusted,
        })),
      };

      // 캐시 저장
      this.playerStatsCache.set(cacheKey, {
        data: result,
        timestamp: Date.now(),
      });

      return result;
    } catch (error) {
      console.error("플레이어 통계 조회 오류:", error);
      throw error;
    }
  }

  // 최근 게임 기록 조회 (1대1 게임용으로 수정)
  async getRecentGames(limit = 20) {
    try {
      const recentGames = await BlackjackGame.find()
        .sort({ gameEndTime: -1 })
        .limit(limit)
        .select({
          roomId: 1, // 세션 ID
          roomName: 1, // 세션 이름
          gameEndTime: 1,
          players: 1,
          totalBets: 1,
          totalPayouts: 1,
          houseProfit: 1,
        });

      return recentGames.map((game) => ({
        id: game._id,
        sessionId: game.roomId, // 세션 ID로 변경
        sessionName: game.roomName, // 세션 이름으로 변경
        gameTime: game.gameEndTime,
        playerName: game.players[0]?.username || "알 수 없음", // 1대1이므로 첫 번째 플레이어
        result: game.players[0]?.result || "알 수 없음",
        totalBets: game.totalBets,
        totalPayouts: game.totalPayouts,
        houseProfit: game.houseProfit,
      }));
    } catch (error) {
      console.error("최근 게임 기록 조회 오류:", error);
      throw error;
    }
  }

  // 전체 통계 조회 (기존과 동일하지만 1대1 게임 기준)
  async getOverallStats() {
    try {
      const [totalGames, totalPlayers, totalBets, totalPayouts] =
        await Promise.all([
          BlackjackGame.countDocuments(),
          BlackjackPlayerStats.countDocuments(),
          BlackjackGame.aggregate([
            { $group: { _id: null, total: { $sum: "$totalBets" } } },
          ]),
          BlackjackGame.aggregate([
            { $group: { _id: null, total: { $sum: "$totalPayouts" } } },
          ]),
        ]);

      return {
        totalGames,
        totalPlayers,
        totalBets: totalBets[0]?.total || 0,
        totalPayouts: totalPayouts[0]?.total || 0,
        houseProfit: (totalBets[0]?.total || 0) - (totalPayouts[0]?.total || 0),
        averageGameLength: "1대1 즉시 완료", // 1대1 게임은 즉시 완료
        gameMode: "1대1 개인 세션", // 게임 모드 표시
      };
    } catch (error) {
      console.error("전체 통계 조회 오류:", error);
      throw error;
    }
  }

  // 활성 세션 통계 조회 (새로 추가)
  async getActiveSessionStats(activeSessions = 0, connectedPlayers = 0) {
    try {
      // 오늘 시작된 게임 수
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const todayGames = await BlackjackGame.countDocuments({
        gameStartTime: { $gte: today },
      });

      // 현재 시간 기준 지난 1시간 내 게임 수
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentGames = await BlackjackGame.countDocuments({
        gameStartTime: { $gte: oneHourAgo },
      });

      return {
        activeSessions,
        connectedPlayers,
        todayGames,
        recentGames,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error("활성 세션 통계 조회 오류:", error);
      throw error;
    }
  }

  // 플레이어 잔액 조정 (관리자 기능)
  async adjustPlayerBalance(userId, amount, reason = "관리자 조정") {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("사용자를 찾을 수 없습니다.");
      }

      const oldBalance = user.balance;
      user.balance += amount;

      if (user.balance < 0) {
        throw new Error("잔액이 음수가 될 수 없습니다.");
      }

      await user.save();

      return {
        success: true,
        username: user.username,
        oldBalance,
        newBalance: user.balance,
        adjustment: amount,
        reason,
      };
    } catch (error) {
      console.error("플레이어 잔액 조정 오류:", error);
      throw error;
    }
  }

  // 캐시 클리어
  clearCache() {
    this.playerStatsCache.clear();
  }
}

module.exports = BlackjackStatsService;
