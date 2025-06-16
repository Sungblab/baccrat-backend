const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/config");
const User = require("../models/user.model");
const Game = require("../models/game.model");
const Chat = require("../models/chat.model");
const {
  updateAndBroadcastLeaderboard,
} = require("../services/leaderboard.service");

module.exports = (io, baccaratGame, userSockets, socket) => {
  // 블랙잭 페이지에서 오는 연결은 바카라 핸들러 적용 안함
  if (
    socket.handshake.headers.referer &&
    socket.handshake.headers.referer.includes("blackjack.html")
  ) {
    return;
  }
  let currentBets = [];
  let bettingActive = false;
  let bettingEndTime = null;
  const userCache = new Map();
  const CACHE_TTL = 5 * 60 * 1000;
  let currentBettingStats = {
    player: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
    banker: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
    tie: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
    player_pair: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
    banker_pair: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
  };
  let resultProcessing = false;
  let fixedGameResult = null;
  
  // 세션 복원을 위한 게임 상태 저장
  let gameSessionState = {
    lastGameTimestamp: null,
    currentGamePhase: 'waiting', // 'waiting', 'betting', 'playing', 'showing_result'
    gameStartTime: null,
    gameEndTime: null
  };
  
  // 사용자 세션 복원을 위한 임시 저장소 (실제 서비스에서는 Redis 등 사용 권장)
  const userSessionStore = new Map();
  
  // 예약 종료 관리
  let scheduledStop = {
    isScheduled: false,
    remainingGames: 0,
    reason: 'user_left'
  };

  let backgroundGameState = {
    isActive: false,
    gameCount: 0,
    maxGames: 0,
    gameTimer: null,
    bettingTimer: null,
    adminSocketId: null,
  };

  // 기존 관리자 자동 베팅 상태 관리
  let adminAutoGameState = {
    isActive: false,
    autoTimer: null,
    countdownTimer: null,
    nextAutoStart: null,
  };

  // 사용자 접속 기반 자동 게임 상태 관리 (백그라운드 방식으로 변경)
  let autoUserGameState = {
    isActive: false,
    connectedUsers: new Set(), // 바카라 게임에 접속한 사용자들 추적
    gameTimer: null,
    bettingTimer: null,
    shouldStopAfterCurrentGame: false, // 현재 게임 완료 후 중지 플래그
    gameCount: 0, // 게임 카운트 추가
    isManualStop: false, // 수동 중지 플래그 (나가기 버튼)
  };

  const cleanUserCache = () => {
    const now = Date.now();
    for (const [userId, data] of userCache.entries()) {
      if (data.cachedAt && now - data.cachedAt > CACHE_TTL) {
        userCache.delete(userId);
      }
    }
  };

  setInterval(cleanUserCache, CACHE_TTL);

  // 관리자 자동 베팅 시작
  function startAdminAutoBetting() {
    if (adminAutoGameState.isActive || backgroundGameState.isActive) return;

    // 사용자 접속 기반 자동 게임이 활성화되어 있으면 중지
    if (autoUserGameState.isActive) {
      stopAutoUserGame(true);
    }

    adminAutoGameState.isActive = true;

    // 베팅이 진행 중이 아니라면 바로 시작
    if (!bettingActive && !resultProcessing) {
      triggerBettingStart();
    }
  }

  // 관리자 자동 베팅 중지
  function stopAdminAutoBetting() {
    if (!adminAutoGameState.isActive) return;

    adminAutoGameState.isActive = false;

    // 타이머들 정리
    if (adminAutoGameState.autoTimer) {
      clearTimeout(adminAutoGameState.autoTimer);
      adminAutoGameState.autoTimer = null;
    }
    if (adminAutoGameState.countdownTimer) {
      clearInterval(adminAutoGameState.countdownTimer);
      adminAutoGameState.countdownTimer = null;
    }
  }

  // 관리자 자동 베팅 다음 게임 스케줄
  function scheduleNextAdminBetting() {
    if (!adminAutoGameState.isActive) return;

    adminAutoGameState.nextAutoStart = Date.now() + 3000; // 3초 후

    adminAutoGameState.autoTimer = setTimeout(() => {
      if (adminAutoGameState.isActive && !bettingActive) {
        triggerBettingStart();
      }
    }, 3000);
  }

  // 관리자 자동 게임 실행
  function runAdminGame() {
    if (!adminAutoGameState.isActive) return;

    let gameResult;
    if (fixedGameResult) {
      gameResult = baccaratGame.playFixedGame(fixedGameResult);
      fixedGameResult = null;
    } else {
      gameResult = baccaratGame.playGame();
    }

    const processedGameResult = {
      ...gameResult,
      stats: currentBettingStats,
      totalBets: currentBets.reduce((sum, bet) => sum + bet.amount, 0),
      playerCount: new Set(currentBets.map((bet) => bet.userId)).size,
    };

    sendCardsToUserHtml(gameResult, async () => {
      io.emit("game_result", {
        result: gameResult.result,
        playerScore: gameResult.playerScore,
        bankerScore: gameResult.bankerScore,
        playerPairOccurred: gameResult.playerPairOccurred,
        bankerPairOccurred: gameResult.bankerPairOccurred,
        timestamp: gameResult.timestamp,
      });

      io.emit("game_result_with_cards", {
        ...gameResult,
        deckInfo: baccaratGame.getDeckInfo(),
      });

      setTimeout(async () => {
        await processAdminGameResult(processedGameResult);

        // 관리자 자동 베팅이 여전히 활성화되어 있으면 다음 베팅 스케줄
        if (adminAutoGameState.isActive) {
          scheduleNextAdminBetting();
        }
      }, 5000);
    });
  }

  // 관리자 게임 결과 처리 (기존 admin_start_game과 동일한 로직)
  async function processAdminGameResult(processedGameResult) {
    if (resultProcessing) return;
    resultProcessing = true;

    try {
      // 게임 저장
      const game = new Game({
        result: processedGameResult.result,
        playerPairOccurred: processedGameResult.playerPairOccurred || false,
        bankerPairOccurred: processedGameResult.bankerPairOccurred || false,
        stats: processedGameResult.stats,
        totalBets: processedGameResult.totalBets,
        playerCount: processedGameResult.playerCount,
        date: new Date(processedGameResult.timestamp),
      });
      await game.save();

      // 베팅 처리 로직 (기존과 동일)
      const userTotalBets = {};
      currentBets.forEach((bet) => {
        if (!userTotalBets[bet.userId]) {
          userTotalBets[bet.userId] = {};
        }
        if (!userTotalBets[bet.userId][bet.choice]) {
          userTotalBets[bet.userId][bet.choice] = 0;
        }
        userTotalBets[bet.userId][bet.choice] += bet.amount;
      });

      for (const bet of currentBets) {
        try {
          const user = await User.findById(bet.userId);
          if (!user) continue;

          let finalWinnings = 0;
          let finalOutcome = "lose";

          if (bet.choice === "player") {
            if (processedGameResult.result === "player") {
              finalWinnings = bet.amount * 2;
              finalOutcome = "win";
            } else if (processedGameResult.result === "tie") {
              finalWinnings = bet.amount;
              finalOutcome = "draw";
            }
          } else if (bet.choice === "banker") {
            if (processedGameResult.result === "banker") {
              finalWinnings = bet.amount * 1.95;
              finalOutcome = "win";
            } else if (processedGameResult.result === "tie") {
              finalWinnings = bet.amount;
              finalOutcome = "draw";
            }
          } else if (bet.choice === "tie") {
            if (processedGameResult.result === "tie") {
              finalWinnings = bet.amount * 9;
              finalOutcome = "win";
            }
          } else if (bet.choice === "player_pair") {
            if (processedGameResult.playerPairOccurred) {
              finalWinnings = bet.amount * 12;
              finalOutcome = "win";
            }
          } else if (bet.choice === "banker_pair") {
            if (processedGameResult.bankerPairOccurred) {
              finalWinnings = bet.amount * 12;
              finalOutcome = "win";
            }
          }

          user.balance += finalWinnings;
          user.bettingHistory.push({
            choice: bet.choice,
            amount: bet.amount,
            result: finalOutcome,
            gameResult: processedGameResult.result,
            date: new Date(),
          });
          await user.save();
        } catch (err) {
          console.error("Bet processing error:", err);
        }
      }

      // 승리 알림
      const notifiedUsers = new Set();
      for (const bet of currentBets) {
        try {
          const userId = bet.userId.toString();
          if (notifiedUsers.has(userId + bet.choice)) continue;

          let finalOutcome = "lose";
          let totalWinnings = 0;
          const userTotalBetAmount = userTotalBets[bet.userId]
            ? userTotalBets[bet.userId][bet.choice]
            : 0;

          if (bet.choice === "player") {
            if (processedGameResult.result === "player") {
              totalWinnings = userTotalBetAmount * 2;
              finalOutcome = "win";
            } else if (processedGameResult.result === "tie") {
              totalWinnings = userTotalBetAmount;
              finalOutcome = "draw";
            }
          } else if (bet.choice === "banker") {
            if (processedGameResult.result === "banker") {
              totalWinnings = userTotalBetAmount * 1.95;
              finalOutcome = "win";
            } else if (processedGameResult.result === "tie") {
              totalWinnings = userTotalBetAmount;
              finalOutcome = "draw";
            }
          } else if (bet.choice === "tie") {
            if (processedGameResult.result === "tie") {
              totalWinnings = userTotalBetAmount * 9;
              finalOutcome = "win";
            }
          } else if (bet.choice === "player_pair") {
            if (processedGameResult.playerPairOccurred) {
              totalWinnings = userTotalBetAmount * 12;
              finalOutcome = "win";
            }
          } else if (bet.choice === "banker_pair") {
            if (processedGameResult.bankerPairOccurred) {
              totalWinnings = userTotalBetAmount * 12;
              finalOutcome = "win";
            }
          }

          if (finalOutcome === "win") {
            const userSocket = userSockets.get(userId);
            if (userSocket) {
              userSocket.emit("you_won", {
                choice: bet.choice,
                totalBetAmount: userTotalBetAmount,
                winnings: totalWinnings,
                gameResult: processedGameResult.result,
              });
              notifiedUsers.add(userId + bet.choice);
            }
          }
        } catch (err) {
          console.error("Win notification error:", err);
        }
      }

      // 결과 처리 완료
      io.emit("result_approved");
      io.emit("update_coins");
      io.emit("admin_result_approved", {
        message: "관리자 자동 게임 결과가 처리되었습니다.",
        gameResult: processedGameResult.result,
        timestamp: new Date(),
      });

      await updateAndBroadcastLeaderboard();

      // 베팅 데이터 초기화
      currentBets = [];
      currentBettingStats = {
        player: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
        banker: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
        tie: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
        player_pair: {
          count: 0,
          total: 0,
          bettor_count: 0,
          total_bet_amount: 0,
        },
        banker_pair: {
          count: 0,
          total: 0,
          bettor_count: 0,
          total_bet_amount: 0,
        },
      };

      userCache.clear();
      io.emit("betting_status", {
        active: bettingActive,
        endTime: bettingEndTime,
        stats: currentBettingStats,
      });
    } catch (err) {
      console.error("Admin game result processing error:", err);
    } finally {
      resultProcessing = false;
    }
  }

  // 베팅 시작 트리거 함수
  function triggerBettingStart() {
    const bettingDuration = 16;
    const endTime = new Date(Date.now() + bettingDuration * 1000);
    bettingActive = true;
    bettingEndTime = endTime;
    io.emit("betting_started");
    io.emit("betting_end_time", endTime);
    setTimeout(() => {
      if (!bettingActive) return;
      bettingActive = false;
      bettingEndTime = null;
      io.emit("betting_closed");

      // 관리자 자동 베팅이 활성화되어 있으면 2초 후 게임 시작
      if (adminAutoGameState.isActive) {
        setTimeout(() => {
          if (adminAutoGameState.isActive && !bettingActive) {
            // 게임 실행 (admin_start_game과 동일한 로직)
            runAdminGame();
          }
        }, 2000);
      }
    }, bettingDuration * 1000);
  }

  // 관리자들에게 사용자 자동 게임 상태 브로드캐스트
  function broadcastUserAutoGameStatus() {
    // 관리자 권한을 가진 사용자들에게만 상태 전송
    for (const [userId, socket] of userSockets.entries()) {
      // 사용자 정보를 캐시에서 확인하거나 DB에서 조회
      User.findById(userId)
        .select("role")
        .then((user) => {
          if (user && (user.role === "admin" || user.role === "superadmin")) {
            socket.emit("user_auto_game_status_update", {
              isActive: autoUserGameState.isActive,
              connectedUsers: autoUserGameState.connectedUsers.size,
            });
          }
        })
        .catch((err) => {
          // 에러 무시 (사용자가 없을 수 있음)
        });
    }
  }

  function sendCardsToUserHtml(gameResult, callback) {
    io.emit("clear_cards_display_on_user_html");
    let delay = 1000;
    let interval = 1000;

    setTimeout(() => {
      if (gameResult.playerHand.cards[0]) {
        io.emit("card_dealt_to_user_ui", {
          target: "player",
          cardValue: gameResult.playerHand.cards[0].value,
          cardSuit: gameResult.playerHand.cards[0].suit,
          cardIndex: 0,
          isNewHand: true,
        });
      }
    }, delay);

    setTimeout(() => {
      if (gameResult.bankerHand.cards[0]) {
        io.emit("card_dealt_to_user_ui", {
          target: "banker",
          cardValue: gameResult.bankerHand.cards[0].value,
          cardSuit: gameResult.bankerHand.cards[0].suit,
          cardIndex: 0,
          isNewHand: true,
        });
      }
    }, delay + interval);

    setTimeout(() => {
      if (gameResult.playerHand.cards[1]) {
        io.emit("card_dealt_to_user_ui", {
          target: "player",
          cardValue: gameResult.playerHand.cards[1].value,
          cardSuit: gameResult.playerHand.cards[1].suit,
          cardIndex: 1,
          isNewHand: false,
        });
      }
    }, delay + interval * 2);

    setTimeout(() => {
      if (gameResult.bankerHand.cards[1]) {
        io.emit("card_dealt_to_user_ui", {
          target: "banker",
          cardValue: gameResult.bankerHand.cards[1].value,
          cardSuit: gameResult.bankerHand.cards[1].suit,
          cardIndex: 1,
          isNewHand: false,
        });
      }
    }, delay + interval * 3);

    setTimeout(() => {
      if (gameResult.playerHand.cards[2]) {
        io.emit("card_dealt_to_user_ui", {
          target: "player",
          cardValue: gameResult.playerHand.cards[2].value,
          cardSuit: gameResult.playerHand.cards[2].suit,
          cardIndex: 2,
          isNewHand: false,
        });
      }
    }, delay + interval * 4);

    setTimeout(() => {
      if (gameResult.bankerHand.cards[2]) {
        io.emit("card_dealt_to_user_ui", {
          target: "banker",
          cardValue: gameResult.bankerHand.cards[2].value,
          cardSuit: gameResult.bankerHand.cards[2].suit,
          cardIndex: 2,
          isNewHand: false,
        });
      }
    }, delay + interval * 5);

    const totalWaitTime = delay + interval * 5 + 1500;
    setTimeout(() => {
      if (callback) {
        callback();
      }
    }, totalWaitTime);
  }

  async function processBackgroundGameResult(processedGameResult) {
    if (resultProcessing) return;
    resultProcessing = true;
    try {
      const game = new Game({
        result: processedGameResult.result,
        playerPairOccurred: processedGameResult.playerPairOccurred || false,
        bankerPairOccurred: processedGameResult.bankerPairOccurred || false,
        stats: processedGameResult.stats,
        totalBets: processedGameResult.totalBets,
        playerCount: processedGameResult.playerCount,
        date: new Date(processedGameResult.timestamp),
      });
      await game.save();

      // 베팅 처리 로직 (관리자 게임과 동일하게 합산 처리)
      const userTotalBets = {};
      currentBets.forEach((bet) => {
        if (!userTotalBets[bet.userId]) {
          userTotalBets[bet.userId] = {};
        }
        if (!userTotalBets[bet.userId][bet.choice]) {
          userTotalBets[bet.userId][bet.choice] = 0;
        }
        userTotalBets[bet.userId][bet.choice] += bet.amount;
      });

      if (currentBets.length > 0) {
        for (const bet of currentBets) {
          try {
            const user = await User.findById(bet.userId);
            if (!user) continue;
            let finalWinnings = 0;
            let finalOutcome = "lose";
            if (
              bet.choice === "player" &&
              processedGameResult.result === "player"
            ) {
              finalWinnings = bet.amount * 2;
              finalOutcome = "win";
            } else if (
              bet.choice === "banker" &&
              processedGameResult.result === "banker"
            ) {
              finalWinnings = bet.amount * 1.95;
              finalOutcome = "win";
            } else if (
              bet.choice === "tie" &&
              processedGameResult.result === "tie"
            ) {
              finalWinnings = bet.amount * 9;
              finalOutcome = "win";
            } else if (
              bet.choice === "player_pair" &&
              processedGameResult.playerPairOccurred
            ) {
              finalWinnings = bet.amount * 12;
              finalOutcome = "win";
            } else if (
              bet.choice === "banker_pair" &&
              processedGameResult.bankerPairOccurred
            ) {
              finalWinnings = bet.amount * 12;
              finalOutcome = "win";
            } else if (
              (bet.choice === "player" || bet.choice === "banker") &&
              processedGameResult.result === "tie"
            ) {
              finalWinnings = bet.amount;
              finalOutcome = "draw";
            }
            user.balance += finalWinnings;
            user.bettingHistory.push({
              choice: bet.choice,
              amount: bet.amount,
              result: finalOutcome,
              gameResult: processedGameResult.result,
              date: new Date(),
            });
            await user.save();
          } catch (err) {
            console.error("Background bet processing error:", err);
          }
        }
      }

      // 승리 알림 (사용자별+선택별로 합산해서 한 번만 알림)
      const notifiedUsers = new Set();
      for (const bet of currentBets) {
        try {
          const userId = bet.userId.toString();
          if (notifiedUsers.has(userId + bet.choice)) continue;

          let finalOutcome = "lose";
          let totalWinnings = 0;
          const userTotalBetAmount = userTotalBets[bet.userId]
            ? userTotalBets[bet.userId][bet.choice]
            : 0;

          if (bet.choice === "player") {
            if (processedGameResult.result === "player") {
              totalWinnings = userTotalBetAmount * 2;
              finalOutcome = "win";
            } else if (processedGameResult.result === "tie") {
              totalWinnings = userTotalBetAmount;
              finalOutcome = "draw";
            }
          } else if (bet.choice === "banker") {
            if (processedGameResult.result === "banker") {
              totalWinnings = userTotalBetAmount * 1.95;
              finalOutcome = "win";
            } else if (processedGameResult.result === "tie") {
              totalWinnings = userTotalBetAmount;
              finalOutcome = "draw";
            }
          } else if (bet.choice === "tie") {
            if (processedGameResult.result === "tie") {
              totalWinnings = userTotalBetAmount * 9;
              finalOutcome = "win";
            }
          } else if (bet.choice === "player_pair") {
            if (processedGameResult.playerPairOccurred) {
              totalWinnings = userTotalBetAmount * 12;
              finalOutcome = "win";
            }
          } else if (bet.choice === "banker_pair") {
            if (processedGameResult.bankerPairOccurred) {
              totalWinnings = userTotalBetAmount * 12;
              finalOutcome = "win";
            }
          }

          if (finalOutcome === "win") {
            const userSocket = userSockets.get(userId);
            if (userSocket) {
              userSocket.emit("you_won", {
                choice: bet.choice,
                totalBetAmount: userTotalBetAmount,
                winnings: totalWinnings,
                gameResult: processedGameResult.result,
              });
              notifiedUsers.add(userId + bet.choice);
            }
          }
        } catch (err) {
          console.error("Win notification error:", err);
        }
      }
      await updateAndBroadcastLeaderboard();
      currentBets = [];
      currentBettingStats = {
        player: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
        banker: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
        tie: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
        player_pair: {
          count: 0,
          total: 0,
          bettor_count: 0,
          total_bet_amount: 0,
        },
        banker_pair: {
          count: 0,
          total: 0,
          bettor_count: 0,
          total_bet_amount: 0,
        },
      };
      io.emit("result_approved");
      io.emit("update_coins");
      io.emit("betting_status", { active: false, stats: currentBettingStats });
    } catch (err) {
      console.error("Background game result processing error:", err);
    } finally {
      resultProcessing = false;
    }
  }

  function stopBackgroundGame() {
    backgroundGameState.isActive = false;
    if (backgroundGameState.gameTimer) {
      clearTimeout(backgroundGameState.gameTimer);
      backgroundGameState.gameTimer = null;
    }
    if (backgroundGameState.bettingTimer) {
      clearTimeout(backgroundGameState.bettingTimer);
      backgroundGameState.bettingTimer = null;
    }
    if (bettingActive) {
      bettingActive = false;
      bettingEndTime = null;
      io.emit("betting_closed");
    }
    if (backgroundGameState.adminSocketId) {
      const adminSocket = [...io.sockets.sockets.values()].find(
        (s) => s.id === backgroundGameState.adminSocketId
      );
      if (adminSocket) {
        adminSocket.emit("background_game_stopped", {
          gameCount: backgroundGameState.gameCount,
          maxGames: backgroundGameState.maxGames,
        });
      }
    }
    backgroundGameState.gameCount = 0;
    backgroundGameState.maxGames = 0;
    backgroundGameState.adminSocketId = null;
  }

  function startBackgroundGame() {
    if (!backgroundGameState.isActive) return;
    const gameResult = baccaratGame.playGame();
    const processedGameResult = {
      ...gameResult,
      stats: currentBettingStats,
      totalBets: currentBets.reduce((sum, bet) => sum + bet.amount, 0),
      playerCount: new Set(currentBets.map((bet) => bet.userId)).size,
    };
    sendCardsToUserHtml(gameResult, async () => {
      io.emit("game_result", {
        result: gameResult.result,
        playerScore: gameResult.playerScore,
        bankerScore: gameResult.bankerScore,
        playerPairOccurred: gameResult.playerPairOccurred,
        bankerPairOccurred: gameResult.bankerPairOccurred,
        timestamp: gameResult.timestamp,
      });
      io.emit("game_result_with_cards", {
        ...gameResult,
        deckInfo: baccaratGame.getDeckInfo(),
      });
      setTimeout(async () => {
        await processBackgroundGameResult(processedGameResult);
        backgroundGameState.gameCount++;
        if (backgroundGameState.adminSocketId) {
          const adminSocket = [...io.sockets.sockets.values()].find(
            (s) => s.id === backgroundGameState.adminSocketId
          );
          if (adminSocket) {
            adminSocket.emit("background_game_status", {
              isActive: backgroundGameState.isActive,
              gameCount: backgroundGameState.gameCount,
              maxGames: backgroundGameState.maxGames,
            });
          }
        }
        if (backgroundGameState.gameCount >= backgroundGameState.maxGames) {
          stopBackgroundGame();
          return;
        }
        if (backgroundGameState.isActive) {
          backgroundGameState.gameTimer = setTimeout(() => {
            if (backgroundGameState.isActive) {
              startBackgroundBetting();
            }
          }, 3000);
        }
      }, 5000);
    });
  }

  function startBackgroundBetting() {
    if (!backgroundGameState.isActive) return;
    const bettingDuration = 16;
    const endTime = new Date(Date.now() + bettingDuration * 1000);
    bettingActive = true;
    bettingEndTime = endTime;
    io.emit("betting_started");
    io.emit("betting_end_time", endTime);
    backgroundGameState.bettingTimer = setTimeout(() => {
      if (!bettingActive || !backgroundGameState.isActive) return;
      bettingActive = false;
      bettingEndTime = null;
      io.emit("betting_closed");
      setTimeout(() => {
        if (backgroundGameState.isActive) {
          startBackgroundGame();
        }
      }, 2000);
    }, bettingDuration * 1000);
  }

  // 소켓 이벤트 처리
  socket.emit("betting_status", {
    active: bettingActive,
    endTime: bettingEndTime,
    stats: currentBettingStats,
  });

  if (bettingActive && bettingEndTime) {
    socket.emit("betting_started");
    socket.emit("betting_end_time", bettingEndTime);
    socket.on("request_my_bets", (token) => {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.id;
        const myCurrentBetsOnChoices = currentBets.reduce((acc, curBet) => {
          if (curBet.userId === userId) {
            acc[curBet.choice] = (acc[curBet.choice] || 0) + curBet.amount;
          }
          return acc;
        }, {});
        socket.emit("my_bets_updated", { myCurrentBetsOnChoices });
      } catch (err) {}
    });
  }

  socket.on("authenticate", (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;
      userSockets.set(userId, socket);
      socket.userId = userId;
    } catch (err) {}
  });

  // 사용자가 바카라 게임에 접속했음을 알림
  socket.on("user_joined_baccarat", async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;
      const user = await User.findById(userId).select("username role");

      if (!user) return;

      // 관리자는 자동 게임 대상에서 제외
      if (user.role === "admin" || user.role === "superadmin") return;

      // 이미 접속한 사용자면 중복 처리 방지
      if (autoUserGameState.connectedUsers.has(userId)) {
        return;
      }

      autoUserGameState.connectedUsers.add(userId);
      socket.userIdForAutoGame = userId;

      // 첫 번째 사용자가 접속하면 자동 게임 시작
      if (
        autoUserGameState.connectedUsers.size === 1 &&
        !backgroundGameState.isActive
      ) {
        startAutoUserGame();
      }

      // 현재 상태를 클라이언트에 알림
      socket.emit("auto_game_status", {
        isActive: autoUserGameState.isActive,
        connectedUsers: autoUserGameState.connectedUsers.size,
      });

      // 관리자들에게 사용자 자동 게임 상태 업데이트 브로드캐스트
      broadcastUserAutoGameStatus();
    } catch (err) {
      console.error("User joined baccarat error:", err);
    }
  });

  socket.on("send_chat_message", async (data) => {
    try {
      if (!socket.userId || !data.message) return;
      const user = await User.findById(socket.userId).select("username role");
      if (!user) return;
      const message = data.message.trim();
      if (message === "" || message.length > 500) return;
      const isAdmin = user.role === "admin";
      const chatMessage = new Chat({
        userId: user._id,
        username: user.username,
        message: message,
        isAdmin: isAdmin,
        isHighlighted: isAdmin,
      });
      await chatMessage.save();
      const messageData = {
        _id: chatMessage._id,
        userId: chatMessage.userId,
        username: chatMessage.username,
        message: chatMessage.message,
        isAdmin: chatMessage.isAdmin,
        isHighlighted: chatMessage.isHighlighted,
        createdAt: chatMessage.createdAt,
      };
      io.emit("new_chat_message", messageData);
      if (isAdmin) {
        io.emit("admin_message_notification", {
          message: messageData,
          type: "admin_chat",
        });
      }
    } catch (err) {
      console.error("Chat message error:", err);
    }
  });

  socket.on("send_highlight_message", async (data) => {
    try {
      if (!socket.userId || !data.message) return;
      const user = await User.findById(socket.userId).select("username role");
      if (!user) return;
      const message = data.message.trim();
      if (message === "" || message.length > 500) return;
      const chatMessage = new Chat({
        userId: user._id,
        username: user.username,
        message: message,
        isAdmin: false,
        isHighlighted: true,
      });
      await chatMessage.save();
      const messageData = {
        _id: chatMessage._id,
        userId: chatMessage.userId,
        username: chatMessage.username,
        message: chatMessage.message,
        isAdmin: chatMessage.isAdmin,
        isHighlighted: chatMessage.isHighlighted,
        createdAt: chatMessage.createdAt,
      };
      io.emit("new_chat_message", messageData);
      io.emit("highlight_message_notification", {
        message: messageData,
        type: "highlight_chat",
      });
    } catch (err) {
      console.error("Highlight message error:", err);
    }
  });

  // 사용자가 바카라 게임에서 나갔음을 알림 (명시적 퇴장)
  socket.on("user_left_baccarat", async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;
      const user = await User.findById(userId).select("username role");

      if (!user) return;

      // 관리자는 자동 게임 대상에서 제외
      if (user.role === "admin" || user.role === "superadmin") return;
      
      // 연결된 사용자 목록에서 제거 (게임은 계속 진행)
      autoUserGameState.connectedUsers.delete(userId);
      
      socket.userIdForAutoGame = null;
      
      console.log(`사용자 ${userId} 바카라 게임 퇴장 (게임은 계속 진행)`);

      // 관리자들에게 사용자 자동 게임 상태 업데이트 브로드캐스트
      broadcastUserAutoGameStatus();
    } catch (err) {
      console.error("User left baccarat error:", err);
    }
  });

  // 게임 수동 중지 (나가기 버튼)
  socket.on("stop_auto_game", async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;
      const user = await User.findById(userId).select("username role");

      if (!user) return;

      // 관리자만 게임 중지 가능
      if (user.role === "admin" || user.role === "superadmin") {
        stopAutoUserGame(true); // 수동 중지
        console.log(`관리자 ${userId}에 의해 자동 게임 중지됨`);
        
        // 모든 클라이언트에게 게임 중지 알림
        io.emit("auto_game_stopped", {
          reason: "manual_stop",
          stoppedBy: user.username
        });
        
        broadcastUserAutoGameStatus();
      }
      
    } catch (err) {
      console.error("Stop auto game error:", err);
    }
  });

  socket.on("disconnect", () => {
    if (socket.userId) {
      userSockets.delete(socket.userId);
    }

    // 바카라 게임에서 사용자 제거 (연결 끊김) - 단순히 목록에서만 제거
    if (socket.userIdForAutoGame) {
      const userId = socket.userIdForAutoGame;
      
      // 연결된 사용자 목록에서 제거 (게임은 계속 진행)
      autoUserGameState.connectedUsers.delete(userId);
      
      console.log(`사용자 ${userId} 연결 해제 (게임은 계속 진행)`);

      // 관리자들에게 사용자 자동 게임 상태 업데이트 브로드캐스트
      broadcastUserAutoGameStatus();
    }
  });

  // 사용자 바카라 게임 참여 (백그라운드 방식)
  socket.on("join_baccarat_game", async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;
      const user = await User.findById(userId).select("username role balance");

      if (!user) return;

      // 관리자는 자동 게임 대상에서 제외
      if (user.role === "admin" || user.role === "superadmin") {
        // 관리자에게는 현재 게임 상태만 전송
        socket.emit("game_state_restored", {
          gameState: gameSessionState,
          bettingActive: bettingActive,
          bettingEndTime: bettingEndTime,
          autoGameActive: autoUserGameState.isActive,
          scheduledStop: scheduledStop
        });
        return;
      }

      socket.userIdForAutoGame = userId;
      
      // 연결된 사용자 목록에 추가
      autoUserGameState.connectedUsers.add(userId);
      
      // 세션 복원 데이터
      const sessionData = {
        gameState: gameSessionState,
        bettingActive: bettingActive,
        bettingEndTime: bettingEndTime,
        autoGameActive: autoUserGameState.isActive,
        scheduledStop: scheduledStop,
        restoredFromSession: false,
        userBalance: user.balance
      };
      
      // 클라이언트에 게임 상태 전송
      socket.emit("game_state_restored", sessionData);

      // 첫 번째 사용자가 접속하고 게임이 비활성화 상태면 시작
      if (!autoUserGameState.isActive && !adminAutoGameState.isActive && !backgroundGameState.isActive) {
        startAutoUserGame();
      }

      // 관리자들에게 사용자 자동 게임 상태 업데이트 브로드캐스트
      broadcastUserAutoGameStatus();
      
      console.log(`사용자 ${userId} 바카라 게임 참여 (접속자: ${autoUserGameState.connectedUsers.size}명)`);
      
    } catch (err) {
      console.error("Join baccarat game error:", err);
      socket.emit("auth_error", "인증 오류가 발생했습니다.");
    }
  });

  socket.on("start_betting", () => {
    triggerBettingStart();
  });

  // 관리자 자동 베팅 시작
  socket.on("admin_auto_start", () => {
    startAdminAutoBetting();
  });

  // 관리자 자동 베팅 중지
  socket.on("admin_auto_stop", () => {
    stopAdminAutoBetting();
  });

  socket.on("admin_start_game", () => {
    if (bettingActive) {
      bettingActive = false;
      bettingEndTime = null;
      io.emit("betting_closed");
    }
    let gameResult;
    if (fixedGameResult) {
      gameResult = baccaratGame.playFixedGame(fixedGameResult);
      fixedGameResult = null;
    } else {
      gameResult = baccaratGame.playGame();
    }
    const processedGameResult = {
      ...gameResult,
      stats: currentBettingStats,
      totalBets: currentBets.reduce((sum, bet) => sum + bet.amount, 0),
      playerCount: new Set(currentBets.map((bet) => bet.userId)).size,
    };
    sendCardsToUserHtml(gameResult, async () => {
      io.emit("game_result", {
        result: gameResult.result,
        playerScore: gameResult.playerScore,
        bankerScore: gameResult.bankerScore,
        playerPairOccurred: gameResult.playerPairOccurred,
        bankerPairOccurred: gameResult.bankerPairOccurred,
        timestamp: gameResult.timestamp,
      });
      io.emit("game_result_with_cards", {
        ...gameResult,
        deckInfo: baccaratGame.getDeckInfo(),
      });
      setTimeout(async () => {
        if (resultProcessing) {
          return;
        }
        resultProcessing = true;
        try {
          const game = new Game({
            result: processedGameResult.result,
            playerPairOccurred: processedGameResult.playerPairOccurred || false,
            bankerPairOccurred: processedGameResult.bankerPairOccurred || false,
            stats: processedGameResult.stats,
            totalBets: processedGameResult.totalBets,
            playerCount: processedGameResult.playerCount,
            date: new Date(processedGameResult.timestamp),
          });
          await game.save();
          const userTotalBets = {};
          currentBets.forEach((bet) => {
            if (!userTotalBets[bet.userId]) {
              userTotalBets[bet.userId] = {};
            }
            if (!userTotalBets[bet.userId][bet.choice]) {
              userTotalBets[bet.userId][bet.choice] = 0;
            }
            userTotalBets[bet.userId][bet.choice] += bet.amount;
          });
          for (const bet of currentBets) {
            try {
              const user = await User.findById(bet.userId);
              if (!user) continue;
              let finalWinnings = 0;
              let finalOutcome = "lose";
              if (bet.choice === "player") {
                if (processedGameResult.result === "player") {
                  finalWinnings = bet.amount * 2;
                  finalOutcome = "win";
                } else if (processedGameResult.result === "tie") {
                  finalWinnings = bet.amount;
                  finalOutcome = "draw";
                }
              } else if (bet.choice === "banker") {
                if (processedGameResult.result === "banker") {
                  finalWinnings = bet.amount * 1.95;
                  finalOutcome = "win";
                } else if (processedGameResult.result === "tie") {
                  finalWinnings = bet.amount;
                  finalOutcome = "draw";
                }
              } else if (bet.choice === "tie") {
                if (processedGameResult.result === "tie") {
                  finalWinnings = bet.amount * 9;
                  finalOutcome = "win";
                }
              } else if (bet.choice === "player_pair") {
                if (processedGameResult.playerPairOccurred) {
                  finalWinnings = bet.amount * 12;
                  finalOutcome = "win";
                }
              } else if (bet.choice === "banker_pair") {
                if (processedGameResult.bankerPairOccurred) {
                  finalWinnings = bet.amount * 12;
                  finalOutcome = "win";
                }
              }
              user.balance += finalWinnings;
              user.bettingHistory.push({
                choice: bet.choice,
                amount: bet.amount,
                result: finalOutcome,
                gameResult: processedGameResult.result,
                date: new Date(),
              });
              await user.save();
            } catch (err) {
              console.error("Bet processing error:", err);
            }
          }
          const notifiedUsers = new Set();
          for (const bet of currentBets) {
            try {
              const userId = bet.userId.toString();
              if (notifiedUsers.has(userId + bet.choice)) continue;
              let finalOutcome = "lose";
              let totalWinnings = 0;
              const userTotalBetAmount = userTotalBets[bet.userId]
                ? userTotalBets[bet.userId][bet.choice]
                : 0;
              if (bet.choice === "player") {
                if (processedGameResult.result === "player") {
                  totalWinnings = userTotalBetAmount * 2;
                  finalOutcome = "win";
                } else if (processedGameResult.result === "tie") {
                  totalWinnings = userTotalBetAmount;
                  finalOutcome = "draw";
                }
              } else if (bet.choice === "banker") {
                if (processedGameResult.result === "banker") {
                  totalWinnings = userTotalBetAmount * 1.95;
                  finalOutcome = "win";
                } else if (processedGameResult.result === "tie") {
                  totalWinnings = userTotalBetAmount;
                  finalOutcome = "draw";
                }
              } else if (bet.choice === "tie") {
                if (processedGameResult.result === "tie") {
                  totalWinnings = userTotalBetAmount * 9;
                  finalOutcome = "win";
                }
              } else if (bet.choice === "player_pair") {
                if (processedGameResult.playerPairOccurred) {
                  totalWinnings = userTotalBetAmount * 12;
                  finalOutcome = "win";
                }
              } else if (bet.choice === "banker_pair") {
                if (processedGameResult.bankerPairOccurred) {
                  totalWinnings = userTotalBetAmount * 12;
                  finalOutcome = "win";
                }
              }
              if (finalOutcome === "win") {
                const userSocket = userSockets.get(userId);
                if (userSocket) {
                  userSocket.emit("you_won", {
                    choice: bet.choice,
                    totalBetAmount: userTotalBetAmount,
                    winnings: totalWinnings,
                    gameResult: processedGameResult.result,
                  });
                  notifiedUsers.add(userId + bet.choice);
                }
              }
            } catch (err) {
              console.error("Win notification error:", err);
            }
          }
          io.emit("result_approved");
          io.emit("update_coins");
          io.emit("admin_result_approved", {
            message: "게임 결과가 자동으로 처리되었습니다.",
            gameResult: processedGameResult.result,
            timestamp: new Date(),
          });
          await updateAndBroadcastLeaderboard();
          currentBets = [];
          currentBettingStats = {
            player: {
              count: 0,
              total: 0,
              bettor_count: 0,
              total_bet_amount: 0,
            },
            banker: {
              count: 0,
              total: 0,
              bettor_count: 0,
              total_bet_amount: 0,
            },
            tie: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
            player_pair: {
              count: 0,
              total: 0,
              bettor_count: 0,
              total_bet_amount: 0,
            },
            banker_pair: {
              count: 0,
              total: 0,
              bettor_count: 0,
              total_bet_amount: 0,
            },
          };
          userCache.clear();
          io.emit("betting_status", {
            active: bettingActive,
            endTime: bettingEndTime,
            stats: currentBettingStats,
          });
        } catch (err) {
          console.error("Game result processing error:", err);
          socket.emit("error", "게임 결과 처리 중 오류가 발생했습니다.");
        } finally {
          resultProcessing = false;
        }
      }, 1500);
    });
  });

  socket.on("admin_shuffle_deck", () => {
    baccaratGame.initializeDeck();
    baccaratGame.shuffleDeck();
    io.emit("deck_shuffled", {
      message: "덱이 셔플되었습니다",
      deckInfo: baccaratGame.getDeckInfo(),
    });
  });

  socket.on("get_deck_info", () => {
    socket.emit("deck_info", baccaratGame.getDeckInfo());
  });

  socket.on("admin_fix_result", (data) => {
    const { result, pattern } = data;
    if (!bettingActive) {
      return socket.emit("error", "베팅 시간이 아닙니다.");
    }
    const validResults = ["player", "banker", "tie"];
    const baseResult = result.split("_")[0];
    if (!validResults.includes(baseResult)) {
      return socket.emit("error", "유효하지 않은 결과입니다.");
    }
    const patternNum = pattern || 1;
    const fixedResultWithPattern = `${baseResult}_${patternNum}`;
    fixedGameResult = fixedResultWithPattern;
    const patternDescriptions = {
      player_1: "내추럴 9 vs 8",
      player_2: "세 번째 카드로 역전승",
      player_3: "간발의 차이로 승리",
      banker_1: "내추럴 9 vs 8",
      banker_2: "뱅커 룰에 의한 승리",
      banker_3: "압도적 승리",
      tie_1: "내추럴 8 타이",
      tie_2: "세 번째 카드 후 타이",
      tie_3: "낮은 점수 타이",
    };
    const resultName =
      baseResult === "player"
        ? "플레이어"
        : baseResult === "banker"
        ? "뱅커"
        : "타이";
    const patternDesc =
      patternDescriptions[fixedResultWithPattern] || "기본 패턴";
    socket.emit("result_fixed", {
      message: `다음 게임 결과가 ${resultName} 승리로 설정되었습니다.\n패턴: ${patternDesc}`,
      fixedResult: fixedResultWithPattern,
      pattern: patternNum,
      patternDescription: patternDesc,
    });
  });

  socket.on("start_background_game", (data) => {
    const { maxGames } = data;
    if (backgroundGameState.isActive) {
      return socket.emit("error", "이미 백그라운드 게임이 진행 중입니다.");
    }
    if (bettingActive || resultProcessing) {
      return socket.emit(
        "error",
        "현재 게임이 진행 중입니다. 잠시 후 다시 시도해주세요."
      );
    }
    if (!maxGames || maxGames < 1 || maxGames > 1000) {
      return socket.emit("error", "게임 수는 1회에서 1000회 사이여야 합니다.");
    }
    backgroundGameState.isActive = true;
    backgroundGameState.gameCount = 0;
    backgroundGameState.maxGames = maxGames;
    backgroundGameState.adminSocketId = socket.id;
    socket.emit("background_game_started", {
      message: `백그라운드 게임이 시작되었습니다. (총 ${maxGames}회)`,
      maxGames: maxGames,
      gameCount: 0,
    });
    setTimeout(() => {
      if (backgroundGameState.isActive) {
        startBackgroundBetting();
      }
    }, 1000);
  });

  socket.on("stop_background_game", () => {
    if (!backgroundGameState.isActive) {
      return socket.emit("error", "백그라운드 게임이 진행 중이지 않습니다.");
    }
    stopBackgroundGame();
    socket.emit("background_game_stopped", {
      message: `백그라운드 게임이 중지되었습니다. (완료된 게임: ${backgroundGameState.gameCount}/${backgroundGameState.maxGames})`,
      gameCount: backgroundGameState.gameCount,
      maxGames: backgroundGameState.maxGames,
    });
  });

  socket.on("get_background_game_status", () => {
    socket.emit("background_game_status", {
      isActive: backgroundGameState.isActive,
      gameCount: backgroundGameState.gameCount,
      maxGames: backgroundGameState.maxGames,
    });
  });

  let bettingUpdateQueue = new Map();
  let bettingUpdateTimer = null;

  const processBettingUpdates = () => {
    if (bettingUpdateQueue.size > 0) {
      io.emit("new_bet", {
        stats: currentBettingStats,
        batchUpdate: true,
      });
      bettingUpdateQueue.clear();
    }
  };

  socket.on("place_bet", async (betData) => {
    const { choice, amount, token } = betData;
    if (!bettingActive) {
      return socket.emit("error", "현재 베팅이 진행 중이지 않습니다.");
    }
    if (!token) {
      return socket.emit("error", "인증 토큰이 필요합니다.");
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;

      // 베팅 시에는 항상 최신 DB 정보를 사용 (캐시 동기화 문제 해결)
      let user = await User.findById(userId).lean();
      if (!user) {
        return socket.emit("error", "사용자를 찾을 수 없습니다.");
      }

      // 캐시도 최신 정보로 업데이트
      user.cachedAt = Date.now();
      userCache.set(userId, user);
      if (
        !["player", "banker", "tie", "player_pair", "banker_pair"].includes(
          choice
        )
      ) {
        return socket.emit("error", "유효하지 않은 선택입니다.");
      }
      if (amount < 1000 || amount > 500000) {
        return socket.emit(
          "error",
          "베팅 금액은 1,000원에서 500,000원 사이여야 합니다."
        );
      }
      if (user.balance < amount) {
        return socket.emit("error", "잔액이 부족합니다.");
      }
      user.balance -= amount;
      user.rollingWagered = (user.rollingWagered || 0) + amount;
      user.cachedAt = Date.now();
      userCache.set(userId, user);
      User.findByIdAndUpdate(userId, {
        $inc: {
          balance: -amount,
          rollingWagered: amount,
        },
      })
        .exec()
        .catch((err) => {
          console.error("DB 업데이트 에러:", err);
        });
      const bet = {
        userId,
        choice,
        amount,
        username: user.username,
      };
      const previousBetsOnThisChoiceByThisUser = currentBets.find(
        (b) => b.userId === userId && b.choice === choice
      );
      currentBets.push(bet);
      currentBettingStats[choice].count++;
      currentBettingStats[choice].total += amount;
      if (!previousBetsOnThisChoiceByThisUser) {
        currentBettingStats[choice].bettor_count++;
      }
      currentBettingStats[choice].total_bet_amount += amount;
      socket.emit("bet_success", {
        message: "베팅이 완료되었습니다.",
        newBalance: user.balance,
      });
      const myCurrentBetsOnChoices = currentBets.reduce((acc, curBet) => {
        if (curBet.userId === userId) {
          acc[curBet.choice] = (acc[curBet.choice] || 0) + curBet.amount;
        }
        return acc;
      }, {});
      socket.emit("my_bets_updated", { myCurrentBetsOnChoices });
      bettingUpdateQueue.set(Date.now(), {
        choice,
        stats: currentBettingStats,
      });
      if (bettingUpdateTimer) {
        clearTimeout(bettingUpdateTimer);
      }
      bettingUpdateTimer = setTimeout(processBettingUpdates, 100);
    } catch (err) {
      console.error("베팅 처리 중 오류:", err);
      socket.emit("error", "베팅 처리 중 오류가 발생했습니다.");
    }
  });

  socket.on("cancel_bet", async (data) => {
    const { token } = data;
    if (!bettingActive) {
      return socket.emit("error", "베팅 시간이 종료되어 취소할 수 없습니다.");
    }
    if (!token) {
      return socket.emit("error", "인증 토큰이 필요합니다.");
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.id;
      // 베팅 취소 시에도 최신 DB 정보를 사용
      let user = await User.findById(userId).lean();
      if (!user) {
        return socket.emit("error", "사용자를 찾을 수 없습니다.");
      }
      // 캐시도 최신 정보로 업데이트
      user.cachedAt = Date.now();
      userCache.set(userId, user);
      let lastBetIndex = -1;
      for (let i = currentBets.length - 1; i >= 0; i--) {
        if (currentBets[i].userId === userId) {
          lastBetIndex = i;
          break;
        }
      }
      if (lastBetIndex === -1) {
        return socket.emit("error", "취소할 베팅을 찾을 수 없습니다.");
      }
      const betToCancel = currentBets[lastBetIndex];
      currentBets.splice(lastBetIndex, 1);
      user.balance += betToCancel.amount;
      user.rollingWagered = Math.max(
        0,
        (user.rollingWagered || 0) - betToCancel.amount
      );
      user.cachedAt = Date.now();
      userCache.set(userId, user);
      User.findByIdAndUpdate(userId, {
        $inc: {
          balance: betToCancel.amount,
          rollingWagered: -betToCancel.amount,
        },
      })
        .exec()
        .catch((err) => {
          console.error("베팅 취소 DB 업데이트 에러:", err);
        });
      if (currentBettingStats[betToCancel.choice]) {
        currentBettingStats[betToCancel.choice].count = Math.max(
          0,
          currentBettingStats[betToCancel.choice].count - 1
        );
        currentBettingStats[betToCancel.choice].total = Math.max(
          0,
          currentBettingStats[betToCancel.choice].total - betToCancel.amount
        );
        const otherBetsOnThisChoiceFromUserAfterCancel = currentBets.find(
          (b) => b.userId === userId && b.choice === betToCancel.choice
        );
        if (!otherBetsOnThisChoiceFromUserAfterCancel) {
          currentBettingStats[betToCancel.choice].bettor_count = Math.max(
            0,
            currentBettingStats[betToCancel.choice].bettor_count - 1
          );
        }
        currentBettingStats[betToCancel.choice].total_bet_amount = Math.max(
          0,
          currentBettingStats[betToCancel.choice].total_bet_amount -
            betToCancel.amount
        );
      }
      io.emit("new_bet", {
        choice: betToCancel.choice,
        stats: currentBettingStats,
      });
      socket.emit("bet_cancelled_success", {
        message: `베팅(선택: ${betToCancel.choice}, 금액: ${betToCancel.amount}원)이 취소되었습니다.`,
        newBalance: user.balance,
        cancelledBet: betToCancel,
      });
      io.emit("update_coins");
      const myCurrentBetsOnChoicesAfterCancel = currentBets.reduce(
        (acc, curBet) => {
          if (curBet.userId === userId) {
            acc[curBet.choice] = (acc[curBet.choice] || 0) + curBet.amount;
          }
          return acc;
        },
        {}
      );
      socket.emit("my_bets_updated", {
        myCurrentBetsOnChoices: myCurrentBetsOnChoicesAfterCancel,
      });
    } catch (err) {
      socket.emit("error", "베팅 취소 처리 중 오류가 발생했습니다.");
    }
  });

  socket.on("request_betting_status", () => {
    socket.emit("betting_status", {
      active: bettingActive,
      endTime: bettingEndTime,
      stats: currentBettingStats,
    });
  });

  // 사용자 접속 기반 자동 게임 시작 함수 (백그라운드 방식으로 변경)
  function startAutoUserGame() {
    if (autoUserGameState.isActive || backgroundGameState.isActive) return;

    // 기존 관리자 자동 베팅이 활성화되어 있으면 중지
    if (adminAutoGameState.isActive) {
      stopAdminAutoBetting();
    }

    autoUserGameState.isActive = true;
    autoUserGameState.isManualStop = false;
    autoUserGameState.gameCount = 0;

    console.log('사용자 기반 자동 게임 시작됨');

    // 베팅이 진행 중이 아니라면 바로 시작
    if (!bettingActive && !resultProcessing) {
      setTimeout(() => {
        if (autoUserGameState.isActive) {
          startAutoUserBetting();
        }
      }, 1000);
    }
  }

  // 사용자 접속 기반 자동 게임 중지 함수 (수동 중지만 가능)
  function stopAutoUserGame(isManualStop = false) {
    if (!autoUserGameState.isActive) return;

    // 수동 중지가 아니면 중지하지 않음 (백그라운드처럼 계속 실행)
    if (!isManualStop) {
      console.log('자동 게임은 수동 중지만 가능합니다.');
      return;
    }

    autoUserGameState.isActive = false;
    autoUserGameState.shouldStopAfterCurrentGame = false;
    autoUserGameState.isManualStop = true;
    
    // 예약 종료 취소
    cancelScheduledStop();

    // 타이머들 정리
    if (autoUserGameState.gameTimer) {
      clearTimeout(autoUserGameState.gameTimer);
      autoUserGameState.gameTimer = null;
    }
    if (autoUserGameState.bettingTimer) {
      clearTimeout(autoUserGameState.bettingTimer);
      autoUserGameState.bettingTimer = null;
    }
    
    // 베팅 진행 중이면 강제 종료
    if (bettingActive) {
      bettingActive = false;
      bettingEndTime = null;
      io.emit("betting_closed");
    }
    
    console.log('사용자 기반 자동 게임 수동 중지됨');
    
    // 게임 상태 업데이트
    updateGameState('waiting');
  }

  // 사용자 접속 기반 자동 베팅 시작 (백그라운드 방식)
  function startAutoUserBetting() {
    if (!autoUserGameState.isActive) return;

    const bettingDuration = 16;
    const endTime = new Date(Date.now() + bettingDuration * 1000);
    bettingActive = true;
    bettingEndTime = endTime;
    
    // 게임 상태 업데이트
    updateGameState('betting', {
      gameStartTime: Date.now(),
      bettingEndTime: endTime
    });

    io.emit("betting_started");
    io.emit("betting_end_time", endTime);

    autoUserGameState.bettingTimer = setTimeout(() => {
      if (!bettingActive || !autoUserGameState.isActive) return;
      bettingActive = false;
      bettingEndTime = null;
      io.emit("betting_closed");

      setTimeout(() => {
        if (autoUserGameState.isActive) {
          runAutoUserGame();
        }
      }, 2000);
    }, bettingDuration * 1000);
  }

  // 사용자 접속 기반 자동 게임 실행 (백그라운드 방식)
  function runAutoUserGame() {
    if (!autoUserGameState.isActive) return;

    let gameResult;
    if (fixedGameResult) {
      gameResult = baccaratGame.playFixedGame(fixedGameResult);
      fixedGameResult = null;
    } else {
      gameResult = baccaratGame.playGame();
    }

    const processedGameResult = {
      ...gameResult,
      stats: currentBettingStats,
      totalBets: currentBets.reduce((sum, bet) => sum + bet.amount, 0),
      playerCount: new Set(currentBets.map((bet) => bet.userId)).size,
    };

    sendCardsToUserHtml(gameResult, async () => {
      io.emit("game_result", {
        result: gameResult.result,
        playerScore: gameResult.playerScore,
        bankerScore: gameResult.bankerScore,
        playerPairOccurred: gameResult.playerPairOccurred,
        bankerPairOccurred: gameResult.bankerPairOccurred,
        timestamp: gameResult.timestamp,
      });

      io.emit("game_result_with_cards", {
        ...gameResult,
        deckInfo: baccaratGame.getDeckInfo(),
      });

      setTimeout(async () => {
        await processAutoUserGameResult(processedGameResult);
        
        autoUserGameState.gameCount++;

        // 게임이 계속 활성화되어 있다면 다음 게임 스케줄
        if (autoUserGameState.isActive) {
          autoUserGameState.gameTimer = setTimeout(() => {
            if (autoUserGameState.isActive) {
              startAutoUserBetting();
            }
          }, 3000);
        }
      }, 5000);
    });
  }

  // 사용자 접속 기반 자동 게임 결과 처리
  async function processAutoUserGameResult(processedGameResult) {
    if (resultProcessing) return;
    resultProcessing = true;

    try {
      const game = new Game({
        result: processedGameResult.result,
        playerPairOccurred: processedGameResult.playerPairOccurred || false,
        bankerPairOccurred: processedGameResult.bankerPairOccurred || false,
        stats: processedGameResult.stats,
        totalBets: processedGameResult.totalBets,
        playerCount: processedGameResult.playerCount,
        date: new Date(processedGameResult.timestamp),
      });
      await game.save();

      // 베팅 처리 로직 (관리자 게임과 동일하게 합산 처리)
      const userTotalBets = {};
      currentBets.forEach((bet) => {
        if (!userTotalBets[bet.userId]) {
          userTotalBets[bet.userId] = {};
        }
        if (!userTotalBets[bet.userId][bet.choice]) {
          userTotalBets[bet.userId][bet.choice] = 0;
        }
        userTotalBets[bet.userId][bet.choice] += bet.amount;
      });

      if (currentBets.length > 0) {
        for (const bet of currentBets) {
          try {
            const user = await User.findById(bet.userId);
            if (!user) continue;

            let finalWinnings = 0;
            let finalOutcome = "lose";

            if (
              bet.choice === "player" &&
              processedGameResult.result === "player"
            ) {
              finalWinnings = bet.amount * 2;
              finalOutcome = "win";
            } else if (
              bet.choice === "banker" &&
              processedGameResult.result === "banker"
            ) {
              finalWinnings = bet.amount * 1.95;
              finalOutcome = "win";
            } else if (
              bet.choice === "tie" &&
              processedGameResult.result === "tie"
            ) {
              finalWinnings = bet.amount * 9;
              finalOutcome = "win";
            } else if (
              bet.choice === "player_pair" &&
              processedGameResult.playerPairOccurred
            ) {
              finalWinnings = bet.amount * 12;
              finalOutcome = "win";
            } else if (
              bet.choice === "banker_pair" &&
              processedGameResult.bankerPairOccurred
            ) {
              finalWinnings = bet.amount * 12;
              finalOutcome = "win";
            } else if (
              (bet.choice === "player" || bet.choice === "banker") &&
              processedGameResult.result === "tie"
            ) {
              finalWinnings = bet.amount;
              finalOutcome = "draw";
            }

            user.balance += finalWinnings;
            user.bettingHistory.push({
              choice: bet.choice,
              amount: bet.amount,
              result: finalOutcome,
              gameResult: processedGameResult.result,
              date: new Date(),
            });
            await user.save();
          } catch (err) {
            console.error("Auto user game bet processing error:", err);
          }
        }
      }

      // 승리 알림 (사용자별+선택별로 합산해서 한 번만 알림)
      const notifiedUsers = new Set();
      for (const bet of currentBets) {
        try {
          const userId = bet.userId.toString();
          if (notifiedUsers.has(userId + bet.choice)) continue;

          let finalOutcome = "lose";
          let totalWinnings = 0;
          const userTotalBetAmount = userTotalBets[bet.userId]
            ? userTotalBets[bet.userId][bet.choice]
            : 0;

          if (bet.choice === "player") {
            if (processedGameResult.result === "player") {
              totalWinnings = userTotalBetAmount * 2;
              finalOutcome = "win";
            } else if (processedGameResult.result === "tie") {
              totalWinnings = userTotalBetAmount;
              finalOutcome = "draw";
            }
          } else if (bet.choice === "banker") {
            if (processedGameResult.result === "banker") {
              totalWinnings = userTotalBetAmount * 1.95;
              finalOutcome = "win";
            } else if (processedGameResult.result === "tie") {
              totalWinnings = userTotalBetAmount;
              finalOutcome = "draw";
            }
          } else if (bet.choice === "tie") {
            if (processedGameResult.result === "tie") {
              totalWinnings = userTotalBetAmount * 9;
              finalOutcome = "win";
            }
          } else if (bet.choice === "player_pair") {
            if (processedGameResult.playerPairOccurred) {
              totalWinnings = userTotalBetAmount * 12;
              finalOutcome = "win";
            }
          } else if (bet.choice === "banker_pair") {
            if (processedGameResult.bankerPairOccurred) {
              totalWinnings = userTotalBetAmount * 12;
              finalOutcome = "win";
            }
          }

          if (finalOutcome === "win") {
            const userSocket = userSockets.get(userId);
            if (userSocket) {
              userSocket.emit("you_won", {
                choice: bet.choice,
                totalBetAmount: userTotalBetAmount,
                winnings: totalWinnings,
                gameResult: processedGameResult.result,
              });
              notifiedUsers.add(userId + bet.choice);
            }
          }
        } catch (err) {
          console.error("Win notification error:", err);
        }
      }

      await updateAndBroadcastLeaderboard();
      currentBets = [];
      currentBettingStats = {
        player: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
        banker: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
        tie: { count: 0, total: 0, bettor_count: 0, total_bet_amount: 0 },
        player_pair: {
          count: 0,
          total: 0,
          bettor_count: 0,
          total_bet_amount: 0,
        },
        banker_pair: {
          count: 0,
          total: 0,
          bettor_count: 0,
          total_bet_amount: 0,
        },
      };

      io.emit("result_approved");
      io.emit("update_coins");
      io.emit("betting_status", { active: false, stats: currentBettingStats });
    } catch (err) {
      console.error("Auto user game result processing error:", err);
    } finally {
      resultProcessing = false;
    }
  }

  // 사용자 세션 저장 함수
  function saveUserSession(userId, sessionData) {
    userSessionStore.set(userId, {
      ...sessionData,
      lastUpdate: Date.now()
    });
  }
  
  // 사용자 세션 복원 함수
  function restoreUserSession(userId) {
    const session = userSessionStore.get(userId);
    if (session && Date.now() - session.lastUpdate < 300000) { // 5분 이내 세션만 복원
      return session;
    }
    return null;
  }
  
  // 게임 상태 업데이트 함수
  function updateGameState(phase, additionalData = {}) {
    gameSessionState.currentGamePhase = phase;
    gameSessionState.lastUpdate = Date.now();
    Object.assign(gameSessionState, additionalData);
  }
  
  // 예약 종료 스케줄링 함수
  function scheduleGameStop(reason = 'user_left', gamesCount = 1) {
    scheduledStop.isScheduled = true;
    scheduledStop.remainingGames = gamesCount;
    scheduledStop.reason = reason;
    
    console.log(`게임 종료 예약됨: ${gamesCount}게임 후 종료 (사유: ${reason})`);
    
    // 관리자들에게 예약 종료 상태 브로드캐스트
    io.emit('scheduled_stop_update', {
      isScheduled: scheduledStop.isScheduled,
      remainingGames: scheduledStop.remainingGames,
      reason: scheduledStop.reason
    });
  }
  
  // 예약 종료 취소 함수
  function cancelScheduledStop() {
    scheduledStop.isScheduled = false;
    scheduledStop.remainingGames = 0;
    
    console.log('게임 종료 예약 취소됨');
    
    // 관리자들에게 예약 종료 취소 브로드캐스트
    io.emit('scheduled_stop_update', {
      isScheduled: false,
      remainingGames: 0,
      reason: null
    });
  }

  return { userSockets };
};
