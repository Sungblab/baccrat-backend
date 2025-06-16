const BlackjackService = require("../services/blackjack.service");
const BlackjackStatsService = require("../services/blackjack-stats.service");
const User = require("../models/user.model");

class BlackjackSocket {
  constructor(io) {
    this.io = io;
    this.blackjackService = new BlackjackService();
    this.blackjackStatsService = new BlackjackStatsService();
    this.adminSockets = new Set(); // 관리자 소켓들
    this.playerSockets = new Map(); // userId -> socket 매핑

    // 주기적으로 비활성 세션 정리 (5분마다)
    setInterval(() => {
      this.blackjackService.cleanupInactiveSessions();
    }, 5 * 60 * 1000);
  }

  // 소켓 이벤트 등록
  handleConnection(socket) {
    // 사용자 인증 처리
    socket.on("authenticate", async (token) => {
      try {
        const user = await this.verifyTokenAndGetUser(token);
        if (user) {
          socket.userId = user.id;
          socket.username = user.username;
          socket.isAuthenticated = true;

          // 플레이어 소켓 매핑 추가
          this.playerSockets.set(user.id, socket);

          // 기존 세션이 있으면 삭제하고 새 세션 생성
          this.blackjackService.deleteGameSession(user.id);
          const session = this.blackjackService.createGameSession(
            user.id,
            user.username,
            user.balance
          );

          socket.emit("authentication_result", {
            success: true,
            user: {
              id: user.id,
              username: user.username,
              balance: user.balance,
            },
            session: this.blackjackService.getSessionData(session),
          });
        } else {
          socket.emit("authentication_result", {
            success: false,
            message: "인증에 실패했습니다.",
          });
        }
      } catch (error) {
        console.error("인증 처리 중 오류:", error);
        socket.emit("authentication_result", {
          success: false,
          message: "인증 처리 중 오류가 발생했습니다.",
        });
      }
    });

    // === 관리자 이벤트들 ===

    // 관리자 블랙잭 페이지 접속
    socket.on("admin_join_blackjack", () => {
      if (!socket.isAuthenticated) {
        socket.emit("admin_action_result", {
          success: false,
          message: "인증이 필요합니다.",
        });
        return;
      }

      this.adminSockets.add(socket);
      socket.join("blackjack_admin");

      // 현재 활성 세션 수 전송
      const activeSessionCount = this.blackjackService.getActiveSessionCount();
      socket.emit("blackjack_session_stats", {
        activeSessions: activeSessionCount,
        connectedPlayers: this.playerSockets.size,
      });
    });

    // 관리자 전체 통계 요청
    socket.on("admin_get_overall_stats", async () => {
      try {
        const stats = await this.blackjackStatsService.getOverallStats();
        const activeSessionCount =
          this.blackjackService.getActiveSessionCount();

        socket.emit("blackjack_overall_stats", {
          ...stats,
          activeSessions: activeSessionCount,
          connectedPlayers: this.playerSockets.size,
        });
      } catch (error) {
        console.error("전체 통계 조회 오류:", error);
        socket.emit("admin_action_result", {
          success: false,
          message: "전체 통계를 가져오는데 실패했습니다.",
        });
      }
    });

    // 관리자 리더보드 요청
    socket.on("admin_get_leaderboard", async (data) => {
      try {
        const { sortBy = "winRate", limit = 50 } = data || {};
        const leaderboard = await this.blackjackStatsService.getLeaderboard(
          sortBy,
          limit
        );
        socket.emit("blackjack_leaderboard", leaderboard);
      } catch (error) {
        console.error("리더보드 조회 오류:", error);
        socket.emit("admin_action_result", {
          success: false,
          message: "리더보드를 가져오는데 실패했습니다.",
        });
      }
    });

    // 관리자 최근 게임 기록 요청
    socket.on("admin_get_recent_games", async (data) => {
      try {
        const { limit = 20 } = data || {};
        const recentGames = await this.blackjackStatsService.getRecentGames(
          limit
        );
        socket.emit("blackjack_recent_games", recentGames);
      } catch (error) {
        console.error("최근 게임 기록 조회 오류:", error);
        socket.emit("admin_action_result", {
          success: false,
          message: "최근 게임 기록을 가져오는데 실패했습니다.",
        });
      }
    });

    // 관리자 플레이어 잔액 조정
    socket.on("admin_adjust_player_balance", async (data) => {
      try {
        const { userId, amount } = data;
        const result = await this.blackjackStatsService.adjustPlayerBalance(
          userId,
          amount
        );

        socket.emit("player_balance_adjusted", result);

        // 해당 플레이어에게 잔액 업데이트 알림
        const playerSocket = this.playerSockets.get(userId);
        if (playerSocket) {
          // 게임 세션 업데이트
          const session = this.blackjackService.getGameSession(userId);
          if (session) {
            session.balance = result.newBalance;
          }

          playerSocket.emit("balance_updated", {
            balance: result.newBalance,
            change: amount,
          });
        }
      } catch (error) {
        console.error("플레이어 잔액 조정 오류:", error);
        socket.emit("player_balance_adjusted", {
          success: false,
          message: error.message || "잔액 조정에 실패했습니다.",
        });
      }
    });

    // === 플레이어 이벤트들 ===

    // 게임 세션 상태 요청
    socket.on("get_game_session", () => {
      if (!socket.isAuthenticated) {
        socket.emit("game_session_error", {
          message: "인증이 필요합니다.",
        });
        return;
      }

      const session = this.blackjackService.getGameSession(socket.userId);
      if (session) {
        socket.emit(
          "game_session_data",
          this.blackjackService.getSessionData(session)
        );
      } else {
        socket.emit("game_session_error", {
          message: "게임 세션을 찾을 수 없습니다.",
        });
      }
    });

    // 베팅 요청
    socket.on("place_bet", async (data) => {
      try {
        const { amount, token } = data;

        if (!socket.isAuthenticated) {
          socket.emit("bet_result", {
            success: false,
            message: "인증이 필요합니다.",
          });
          return;
        }

        // 토큰 재검증으로 최신 잔액 확인 (바카라 시스템 참고)
        const user = await this.verifyTokenAndGetUser(token);
        if (!user) {
          socket.emit("bet_result", {
            success: false,
            message: "인증에 실패했습니다.",
          });
          return;
        }

        // 세션 잔액을 DB 잔액으로 동기화
        const session = this.blackjackService.getGameSession(socket.userId);
        if (session) {
          session.balance = user.balance;
        }

        const result = this.blackjackService.placeBet(socket.userId, amount);

        if (result.success) {
          // DB 잔액을 서비스 세션 잔액과 동기화
          user.balance = result.session.balance;
          await user.save();

          socket.emit("bet_result", result);
          socket.emit("session_updated", result.session);

          // 실시간 잔액 업데이트
          socket.emit("balance_updated", {
            balance: user.balance,
          });
        } else {
          socket.emit("bet_result", result);
        }
      } catch (error) {
        console.error("베팅 처리 오류:", error);
        socket.emit("bet_result", {
          success: false,
          message: "베팅 처리 중 오류가 발생했습니다.",
        });
      }
    });

    // 게임 시작 요청
    socket.on("start_game", () => {
      if (!socket.isAuthenticated) {
        socket.emit("game_result", {
          success: false,
          message: "인증이 필요합니다.",
        });
        return;
      }

      const result = this.blackjackService.startGame(socket.userId);

      if (result.success) {
        socket.emit("game_started", {
          success: true,
          session: result.session,
          message: result.message,
          needsBlackjackCheck: result.needsBlackjackCheck,
        });
        socket.emit("session_updated", result.session);
      } else {
        socket.emit("game_result", result);
      }
    });

    // 블랙잭 체크 요청 (플레이어 블랙잭만)
    socket.on("check_blackjack", () => {
      if (!socket.isAuthenticated) {
        socket.emit("blackjack_check_result", {
          success: false,
          message: "인증이 필요합니다.",
        });
        return;
      }

      const result = this.blackjackService.checkBlackjack(socket.userId);

      if (result.success) {
        socket.emit("blackjack_check_result", result);

        if (result.isBlackjack && result.needsDealerCheck) {
          // 플레이어 블랙잭인 경우 딜러 턴으로 바로 진행
          setTimeout(() => {
            this.processDealerTurn(socket.userId);
          }, 1500);
        } else if (!result.isBlackjack) {
          // 플레이어 블랙잭이 아니면 정상 게임 진행
          // enableGameActions는 클라이언트에서 처리
        }
      } else {
        socket.emit("blackjack_check_result", result);
      }
    });

    // 히트 요청
    socket.on("hit", () => {
      if (!socket.isAuthenticated) {
        socket.emit("action_result", {
          success: false,
          message: "인증이 필요합니다.",
        });
        return;
      }

      const result = this.blackjackService.hit(socket.userId);

      if (result.success) {
        // 자동 스탠드인 경우 stand_result로 전송
        if (result.autoStand) {
          socket.emit("stand_result", {
            success: true,
            message: result.message,
            session: result.session,
            autoStand: true,
          });
        } else {
          socket.emit("hit_result", {
            success: true,
            newCard: result.newCard,
            handValue: result.handValue,
            message: result.message,
            session: result.session,
            isBust: result.isBust || false,
            wasDoubled: result.wasDoubled || false,
            isSplit: result.isSplit || false,
            currentHandIndex: result.currentHandIndex || 0,
            nextHandIndex: result.nextHandIndex || null,
            allHandsComplete: result.allHandsComplete || false,
          });
        }
        socket.emit("session_updated", result.session);

        // 스플릿에서 다음 핸드로 이동하는 경우
        if (result.isSplit && result.nextHandIndex !== undefined) {
          setTimeout(() => {
            socket.emit("split_next_hand", {
              nextHandIndex: result.nextHandIndex,
              session: result.session,
            });
          }, 1000);
        }

        // 모든 핸드가 완료되거나 더블다운 후 딜러 턴 자동 시작
        if (
          (result.allHandsComplete || (result.wasDoubled && !result.isBust)) &&
          result.session.status === "dealer-turn"
        ) {
          setTimeout(() => {
            this.processDealerTurn(socket.userId);
          }, 1500);
        }

        // 버스트이거나 게임 종료인 경우
        if (result.isBust || result.session.status === "finished") {
          // 스플릿이 아니거나 모든 핸드가 완료된 경우에만 게임 종료
          if (!result.isSplit || result.allHandsComplete) {
            this.finishGame(socket.userId);
          }
        }
      } else {
        socket.emit("action_result", result);
      }
    });

    // 스탠드 요청
    socket.on("stand", () => {
      if (!socket.isAuthenticated) {
        socket.emit("action_result", {
          success: false,
          message: "인증이 필요합니다.",
        });
        return;
      }

      const result = this.blackjackService.stand(socket.userId);

      if (result.success) {
        socket.emit("stand_result", {
          success: true,
          message: result.message,
          session: result.session,
          nextHandIndex: result.nextHandIndex || null,
          allHandsComplete: result.allHandsComplete || false,
        });
        socket.emit("session_updated", result.session);

        // 스플릿에서 다음 핸드로 이동하는 경우
        if (result.nextHandIndex !== undefined) {
          setTimeout(() => {
            socket.emit("split_next_hand", {
              nextHandIndex: result.nextHandIndex,
              session: result.session,
            });
          }, 1000);
        }

        // 딜러 턴인 경우 딜러 카드를 하나씩 처리
        if (result.session.status === "dealer-turn") {
          setTimeout(() => {
            this.processDealerTurn(socket.userId);
          }, 1000);
        }
        // 게임이 종료된 경우
        else if (result.session.status === "finished") {
          this.finishGame(socket.userId);
        }
      } else {
        socket.emit("action_result", result);
      }
    });

    // 더블다운 요청
    socket.on("double", async (data) => {
      try {
        if (!socket.isAuthenticated) {
          socket.emit("action_result", {
            success: false,
            message: "인증이 필요합니다.",
          });
          return;
        }

        const { token } = data;
        const user = await this.verifyTokenAndGetUser(token);
        if (!user) {
          socket.emit("action_result", {
            success: false,
            message: "인증에 실패했습니다.",
          });
          return;
        }

        const result = this.blackjackService.double(socket.userId);

        if (result.success) {
          // 추가 베팅 금액 차감
          const session = this.blackjackService.getGameSession(socket.userId);
          const additionalBet = session.currentBet / 2; // 더블다운으로 추가된 금액

          user.balance -= additionalBet;
          await user.save();

          socket.emit("double_result", {
            success: true,
            message: result.message,
            session: result.session,
            doubledDown: result.doubledDown, // 더블다운 완료 플래그
          });
          socket.emit("session_updated", result.session);
        } else {
          socket.emit("action_result", result);
        }
      } catch (error) {
        console.error("더블다운 처리 오류:", error);
        socket.emit("action_result", {
          success: false,
          message: "더블다운 처리 중 오류가 발생했습니다.",
        });
      }
    });

    // 보험 요청
    socket.on("insurance", async (data) => {
      try {
        if (!socket.isAuthenticated) {
          socket.emit("action_result", {
            success: false,
            message: "인증이 필요합니다.",
          });
          return;
        }

        const { token } = data;
        const user = await this.verifyTokenAndGetUser(token);
        if (!user) {
          socket.emit("action_result", {
            success: false,
            message: "인증에 실패했습니다.",
          });
          return;
        }

        const result = this.blackjackService.insurance(socket.userId);

        if (result.success) {
          // 보험 베팅 금액 차감
          user.balance -= result.insuranceAmount;
          await user.save();

          socket.emit("insurance_result", {
            success: true,
            message: result.message,
            session: result.session,
            insuranceAmount: result.insuranceAmount,
          });
          socket.emit("session_updated", result.session);
        } else {
          socket.emit("action_result", result);
        }
      } catch (error) {
        console.error("보험 처리 오류:", error);
        socket.emit("action_result", {
          success: false,
          message: "보험 처리 중 오류가 발생했습니다.",
        });
      }
    });

    // 스플릿 요청
    socket.on("split", async (data) => {
      try {
        if (!socket.isAuthenticated) {
          socket.emit("action_result", {
            success: false,
            message: "인증이 필요합니다.",
          });
          return;
        }

        const { token } = data;
        const user = await this.verifyTokenAndGetUser(token);
        if (!user) {
          socket.emit("action_result", {
            success: false,
            message: "인증에 실패했습니다.",
          });
          return;
        }

        const result = this.blackjackService.split(socket.userId);

        if (result.success) {
          // 추가 베팅 금액 차감
          user.balance -= result.additionalBet;
          await user.save();

          socket.emit("split_result", {
            success: true,
            message: result.message,
            session: result.session,
            additionalBet: result.additionalBet,
          });
          socket.emit("session_updated", result.session);
        } else {
          socket.emit("action_result", result);
        }
      } catch (error) {
        console.error("스플릿 처리 오류:", error);
        socket.emit("action_result", {
          success: false,
          message: "스플릿 처리 중 오류가 발생했습니다.",
        });
      }
    });

    // 서렌더 요청
    socket.on("surrender", async () => {
      try {
        if (!socket.isAuthenticated) {
          socket.emit("action_result", {
            success: false,
            message: "인증이 필요합니다.",
          });
          return;
        }

        const user = await User.findById(socket.userId);
        if (!user) {
          socket.emit("action_result", {
            success: false,
            message: "사용자를 찾을 수 없습니다.",
          });
          return;
        }

        const result = this.blackjackService.surrender(socket.userId);

        if (result.success) {
          // 서렌더 시 잔액 업데이트 (이미 서비스에서 처리됨)
          user.balance = result.session.balance;
          await user.save();

          socket.emit("surrender_result", {
            success: true,
            message: result.message,
            session: result.session,
            surrenderAmount: result.surrenderAmount,
            lossAmount: result.lossAmount,
          });
          socket.emit("session_updated", result.session);

          // 서렌더 시 게임 즉시 종료
          setTimeout(() => {
            this.finishGame(socket.userId);
          }, 1500);
        } else {
          socket.emit("action_result", result);
        }
      } catch (error) {
        console.error("서렌더 처리 오류:", error);
        socket.emit("action_result", {
          success: false,
          message: "서렌더 처리 중 오류가 발생했습니다.",
        });
      }
    });

    // 새 게임 요청
    socket.on("new_game", () => {
      if (!socket.isAuthenticated) {
        socket.emit("game_result", {
          success: false,
          message: "인증이 필요합니다.",
        });
        return;
      }

      const result = this.blackjackService.newGame(socket.userId);

      if (result.success) {
        socket.emit("new_game_result", {
          success: true,
          message: result.message,
          session: result.session,
        });
        socket.emit("session_updated", result.session);
      } else {
        socket.emit("game_result", result);
      }
    });

    // 세션 강제 초기화 요청 (베팅 실패 시 사용)
    socket.on("reset_session", async () => {
      if (!socket.isAuthenticated) {
        socket.emit("session_reset_result", {
          success: false,
          message: "인증이 필요합니다.",
        });
        return;
      }

      try {
        // 기존 세션 삭제
        this.blackjackService.deleteGameSession(socket.userId);

        // 새 세션 생성
        const user = await User.findById(socket.userId);
        if (!user) {
          socket.emit("session_reset_result", {
            success: false,
            message: "사용자를 찾을 수 없습니다.",
          });
          return;
        }

        const newSession = this.blackjackService.createGameSession(
          socket.userId,
          socket.username,
          user.balance
        );

        socket.emit("session_reset_result", {
          success: true,
          message: "", // 알림 메시지 제거
          session: this.blackjackService.getSessionData(newSession),
        });
      } catch (error) {
        console.error("세션 초기화 오류:", error);
        socket.emit("session_reset_result", {
          success: false,
          message: "세션 초기화 중 오류가 발생했습니다.",
        });
      }
    });

    // 딜러 턴 시작 요청 처리
    socket.on("start_dealer_turn", () => {
      if (!socket.isAuthenticated || !socket.userId) {
        socket.emit("error", { message: "인증이 필요합니다." });
        return;
      }

      const session = this.blackjackService.getGameSession(socket.userId);
      if (!session) {
        socket.emit("error", { message: "게임 세션을 찾을 수 없습니다." });
        return;
      }

      if (session.status !== "dealer-turn") {
        socket.emit("error", { message: "딜러 턴 상태가 아닙니다." });
        return;
      }

      // 딜러 턴 프로세스 시작
      this.processDealerTurn(socket.userId);
    });

    // 연결 해제 처리
    socket.on("disconnect", () => {
      if (socket.userId) {
        this.playerSockets.delete(socket.userId);
      }

      this.adminSockets.delete(socket);
    });
  }

  // 딜러 턴 처리 (개선된 버전)
  processDealerTurn(userId) {
    const session = this.blackjackService.getGameSession(userId);
    if (!session) {
      return;
    }

    if (session.status !== "dealer-turn") {
      return;
    }

    const playerSocket = this.playerSockets.get(userId);
    if (!playerSocket || !playerSocket.connected) {
      // 소켓이 없거나 연결이 끊어져도 게임 결과는 처리
      this.finalizeDealerTurn(userId);
      return;
    }

    // 기존 타임아웃 정리
    if (session.dealerTurnTimeout) {
      clearTimeout(session.dealerTurnTimeout);
      delete session.dealerTurnTimeout;
    }

    // 딜러턴 시작 알림 먼저 전송
    try {
      playerSocket.emit("dealer_turn_started", {
        session: this.blackjackService.getSessionData(session),
        message: "딜러 턴이 시작됩니다.",
      });
    } catch (error) {
      console.error(`[BlackjackSocket] 딜러턴 시작 알림 전송 오류:`, error);
    }

    // 딜러 턴 타임아웃 설정 (30초)
    const dealerTurnTimeout = setTimeout(() => {
      this.finalizeDealerTurn(userId);
    }, 30000);

    session.dealerTurnTimeout = dealerTurnTimeout;

    // 딜러 숨겨진 카드 공개 (500ms 후)
    setTimeout(() => {
      this.revealDealerHiddenCard(userId);
    }, 500);
  }

  // 딜러 숨겨진 카드 공개 (분리된 함수)
  revealDealerHiddenCard(userId) {
    const session = this.blackjackService.getGameSession(userId);
    const playerSocket = this.playerSockets.get(userId);

    if (!session || !playerSocket || !playerSocket.connected) {
      return;
    }

    if (session.status !== "dealer-turn") {
      return;
    }

    // 먼저 딜러의 숨겨진 카드 공개
    if (session.dealerHand.length > 0) {
      const hiddenCard = session.dealerHand[0];

      try {
        const dealerValue = this.blackjackService.calculateHandValue(
          session.dealerHand
        );

        playerSocket.emit("dealer_hidden_card_revealed", {
          hiddenCard: {
            value: hiddenCard.value,
            suit: hiddenCard.suit,
          },
          dealerValue: dealerValue,
          session: this.blackjackService.getSessionData(session),
        });

        // 카드 공개 후 딜러 블랙잭 체크
        setTimeout(() => {
          this.checkDealerBlackjackAfterReveal(userId);
        }, 1500);
      } catch (error) {
        console.error(`[BlackjackSocket] 딜러 카드 공개 전송 오류:`, error);
        // 오류 발생 시에도 딜러턴 계속 진행
        setTimeout(() => {
          this.continueDealerTurn(userId);
        }, 1000);
      }
    } else {
      console.error(`[BlackjackSocket] 딜러 카드가 없음: ${userId}`);
      this.finalizeDealerTurn(userId);
    }
  }

  // 딜러 카드 공개 후 블랙잭 체크
  checkDealerBlackjackAfterReveal(userId) {
    const session = this.blackjackService.getGameSession(userId);
    const playerSocket = this.playerSockets.get(userId);

    if (!session || !playerSocket || !playerSocket.connected) {
      return;
    }

    // 플레이어 블랙잭 여부 정확히 체크
    const playerValue = this.blackjackService.calculateHandValue(
      session.playerHand
    );
    const playerBlackjack =
      playerValue === 21 && session.playerHand.length === 2;

    // 딜러 블랙잭 체크
    const dealerBlackjackResult =
      this.blackjackService.checkDealerBlackjack(session);

    if (dealerBlackjackResult.isDealerBlackjack) {
      // 딜러 블랙잭인 경우
      try {
        playerSocket.emit("dealer_blackjack", {
          holeCard: dealerBlackjackResult.holeCard,
          session: dealerBlackjackResult.session,
          results: session.handResults,
        });

        // 게임 즉시 종료
        setTimeout(() => {
          this.finishGame(userId);
        }, 1500);
      } catch (error) {
        console.error(`[BlackjackSocket] 딜러 블랙잭 알림 전송 오류:`, error);
        this.finishGame(userId);
      }
    } else {
      // 딜러 블랙잭이 아닌 경우
      // 플레이어 블랙잭이었다면 즉시 승리 처리
      if (playerBlackjack) {
        session.status = "finished";
        session.gameEndTime = new Date();
        const payout =
          session.currentBet + Math.floor(session.currentBet * 1.5);
        console.log(
          `[BlackjackSocket] 플레이어 블랙잭 승리! userId: ${userId}, bet: ${
            session.currentBet
          }, payout: ${payout}, 기존잔액: ${session.balance}, 새잔액: ${
            session.balance + payout
          }`
        );
        session.handResults = [{ result: "blackjack", payout }];
        session.totalPayout = payout;
        session.balance += payout;

        try {
          playerSocket.emit("player_blackjack_win", {
            message: "플레이어 블랙잭 승리!",
            payout: payout,
            session: this.blackjackService.getSessionData(session),
          });
        } catch (error) {
          console.error(
            `[BlackjackSocket] 플레이어 블랙잭 승리 알림 전송 오류:`,
            error
          );
        }

        // 게임 종료 처리
        setTimeout(() => {
          this.finishGame(userId);
        }, 1500);
      } else {
        // 일반적인 딜러 턴 계속 진행
        this.continueDealerTurn(userId);
      }
    }
  }

  // 딜러 턴 계속 진행
  continueDealerTurn(userId) {
    const session = this.blackjackService.getGameSession(userId);
    const playerSocket = this.playerSockets.get(userId);

    if (!session || !playerSocket || !playerSocket.connected) {
      return;
    }

    if (session.status !== "dealer-turn") {
      return;
    }

    const dealerValue = this.blackjackService.calculateHandValue(
      session.dealerHand
    );

    // 딜러가 17 미만이면 카드 추가
    if (dealerValue < 17) {
      const newCard = this.blackjackService.drawCard(session.deck);
      if (newCard) {
        session.dealerHand.push(newCard);

        try {
          playerSocket.emit("dealer_card_dealt", {
            newCard: newCard,
            cardIndex: session.dealerHand.length - 1,
            dealerValue: this.blackjackService.calculateHandValue(
              session.dealerHand
            ),
            session: this.blackjackService.getSessionData(session),
          });

          // 1초 후 다시 체크
          setTimeout(() => {
            this.continueDealerTurn(userId);
          }, 1000);
        } catch (error) {
          console.error(`[BlackjackSocket] 딜러 카드 추가 전송 오류:`, error);
          this.finalizeDealerTurn(userId);
        }
      } else {
        console.error(`[BlackjackSocket] 카드 뽑기 실패: ${userId}`);
        this.finalizeDealerTurn(userId);
      }
    } else {
      // 딜러가 17 이상이면 게임 종료
      this.finalizeDealerTurn(userId);
    }
  }

  // 딜러 턴 완료 및 게임 결과 처리
  finalizeDealerTurn(userId) {
    const session = this.blackjackService.getGameSession(userId);
    if (!session) {
      return;
    }

    // 타임아웃 정리
    if (session.dealerTurnTimeout) {
      clearTimeout(session.dealerTurnTimeout);
      delete session.dealerTurnTimeout;
    }

    const playerSocket = this.playerSockets.get(userId);
    if (playerSocket && playerSocket.connected) {
      try {
        playerSocket.emit("dealer_turn_completed", {
          session: this.blackjackService.getSessionData(session),
          message: "딜러 턴이 완료되었습니다.",
        });
      } catch (error) {
        console.error(`[BlackjackSocket] 딜러턴 완료 알림 전송 오류:`, error);
      }
    }

    // 게임 결과 계산 및 처리 (500ms 후)
    setTimeout(async () => {
      await this.finishGame(userId);
    }, 500);
  }

  // 게임 종료 처리 (개선된 버전)
  async finishGame(userId) {
    const session = this.blackjackService.getGameSession(userId);
    if (!session) {
      return;
    }

    // 이미 종료된 게임인지 확인
    if (session.status === "finished") {
      return;
    }

    try {
      // 게임 결과 계산 (상태 초기화는 나중에 처리)
      const gameResults = this.blackjackService.determineGameResult(session);

      // 게임 결과가 객체 형태인지 확인 (보험 결과 포함)
      const handResults = gameResults.handResults || gameResults;
      const insuranceResult = gameResults.insuranceResult || null;

      if (!handResults || handResults.length === 0) {
        console.error(`[BlackjackSocket] 게임 결과 계산 실패: ${userId}`);
        return;
      }

      // 게임 결과를 데이터베이스에 저장 (세션 초기화 전에)
      try {
        await this.saveGameToDatabase(session, handResults, insuranceResult);
      } catch (saveError) {
        console.error(`[BlackjackSocket] 게임 저장 오류:`, saveError);
        // 저장 오류가 있어도 게임은 계속 진행
      }

      // 사용자 잔액을 DB에 업데이트
      try {
        const user = await User.findById(userId);
        if (user) {
          console.log(
            `[BlackjackSocket] DB 잔액 업데이트: userId: ${userId}, 기존 DB 잔액: ${user.balance}, 새 잔액: ${session.balance}`
          );
          user.balance = session.balance;
          await user.save();
          console.log(
            `[BlackjackSocket] DB 잔액 업데이트 완료: ${user.balance}`
          );
        } else {
          console.error(`[BlackjackSocket] 사용자를 찾을 수 없음: ${userId}`);
        }
      } catch (balanceError) {
        console.error(`[BlackjackSocket] 잔액 업데이트 오류:`, balanceError);
      }

      // 게임 저장 완료 후 다음 게임을 위한 세션 초기화
      this.blackjackService.prepareForNextGame(session);

      const playerSocket = this.playerSockets.get(userId);
      if (playerSocket && playerSocket.connected) {
        try {
          // 게임 종료 결과 전송
          playerSocket.emit("game_finished", {
            success: true,
            session: this.blackjackService.getSessionData(session),
            results: handResults,
            insuranceResult: insuranceResult,
            totalPayout: gameResults.totalPayout,
            message: "게임이 완료되었습니다.",
          });

          // 잔액 업데이트 알림
          playerSocket.emit("balance_updated", {
            balance: session.balance,
          });

          // 게임 종료 후 즉시 상태를 waiting으로 변경
          if (session) {
            session.status = "waiting";
          }
        } catch (error) {
          console.error(`[BlackjackSocket] 게임 종료 결과 전송 오류:`, error);
        }
      } else {
        // 소켓이 없어도 상태는 초기화
        if (session) {
          session.status = "waiting";
        }
      }
    } catch (error) {
      console.error(`[BlackjackSocket] 게임 종료 처리 오류:`, error);

      // 오류 발생 시에도 세션 정리
      if (session) {
        session.status = "waiting"; // finished가 아닌 waiting으로 설정
        this.blackjackService.prepareForNextGame(session);
      }

      const playerSocket = this.playerSockets.get(userId);
      if (playerSocket && playerSocket.connected) {
        try {
          playerSocket.emit("game_finished", {
            success: false,
            message: "게임 처리 중 오류가 발생했습니다.",
            session: this.blackjackService.getSessionData(session),
          });
        } catch (emitError) {
          console.error(`[BlackjackSocket] 오류 메시지 전송 실패:`, emitError);
        }
      }
    }
  }

  // 게임 결과를 데이터베이스에 저장
  async saveGameToDatabase(session, handResults, insuranceResult = null) {
    try {
      // gameStartTime 검증 및 보정
      let gameStartTime = session.gameStartTime;
      if (!gameStartTime) {
        gameStartTime = new Date(Date.now() - 60000); // 1분 전으로 설정
        console.warn(
          `[BlackjackSocket] gameStartTime이 null이어서 기본값으로 설정: ${session.username}`
        );
      }

      // 딜러 데이터 준비
      const dealerValue = this.blackjackService.calculateHandValue(
        session.dealerHand
      );
      const dealerData = {
        cards: session.dealerHand,
        score: dealerValue,
        isBusted: dealerValue > 21,
      };

      // 플레이어 데이터 준비 (1대1 게임이므로 1명)
      const playersData = [
        {
          userId: session.userId,
          username: session.username,
          seatNumber: 1, // 1대1이므로 항상 1번 자리
          cards: session.playerHand,
          score: this.blackjackService.calculateHandValue(session.playerHand),
          betAmount: session.currentBet,
          result: handResults[0].result,
          payout: handResults[0].payout,
          isBlackjack: handResults[0].result === "blackjack",
          isBusted: handResults[0].result === "bust",
          hasDoubled: session.hasDoubled || false,
          insurance: session.insuranceBet || 0,
          insuranceResult: insuranceResult,
        },
      ];

      // 통계 서비스를 통해 저장
      await this.blackjackStatsService.saveGameResult(
        session.sessionId,
        `블랙잭-${session.username}`, // 세션 이름
        gameStartTime, // 검증된 gameStartTime 사용
        dealerData,
        playersData
      );
    } catch (error) {
      console.error(`[BlackjackSocket] 게임 기록 DB 저장 실패:`, error);
      throw error;
    }
  }

  // 관리자들에게 브로드캐스트
  broadcastToAdmins(event, data) {
    this.io.to("blackjack_admin").emit(event, data);
  }

  // 토큰 검증 및 사용자 정보 가져오기
  async verifyTokenAndGetUser(token) {
    try {
      const jwt = require("jsonwebtoken");
      const { JWT_SECRET } = require("../config/config");

      if (!token) {
        return null;
      }

      const decoded = jwt.verify(token, JWT_SECRET);

      const user = await User.findById(decoded.id);
      if (user) {
        return user;
      } else {
        return null;
      }
    } catch (error) {
      return null;
    }
  }
}

module.exports = BlackjackSocket;
