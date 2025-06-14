const crypto = require("crypto");

class BlackjackService {
  constructor() {
    // 개별 게임 세션 관리 (userId를 키로 사용)
    this.gameSessions = new Map();

    // 카드 덱 생성용 데이터
    this.suits = ["H", "D", "C", "S"]; // Hearts, Diamonds, Clubs, Spades
    this.values = [
      "A",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "0", // deckofcardsapi.com에서 10을 0으로 표현
      "J",
      "Q",
      "K",
    ];
  }

  // 새 게임 세션 생성
  createGameSession(userId, username, balance) {
    const sessionId = crypto.randomUUID();

    const gameSession = {
      sessionId,
      userId,
      username,
      balance,
      status: "waiting", // waiting, betting, dealing, playing, dealer-turn, finished
      deck: this.createAndShuffleDeck(),
      playerHand: [],
      dealerHand: [],
      currentBet: 0,
      insuranceBet: 0,
      gameStartTime: null,
      gameEndTime: null,
      canDouble: false,
      canSplit: false,
      canInsurance: false,
      splitHands: [], // 스플릿된 핸드들
      currentHandIndex: 0, // 현재 플레이 중인 핸드 인덱스
      isSplit: false,
      handResults: [], // 각 핸드의 결과
      totalPayout: 0,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    this.gameSessions.set(userId, gameSession);
    return gameSession;
  }

  // 게임 세션 가져오기
  getGameSession(userId) {
    return this.gameSessions.get(userId);
  }

  // 게임 세션 삭제
  deleteGameSession(userId) {
    return this.gameSessions.delete(userId);
  }

  // 덱 생성 및 섞기
  createAndShuffleDeck() {
    const deck = [];

    // 표준 52장 카드 생성
    for (let suit of this.suits) {
      for (let value of this.values) {
        deck.push({ value, suit });
      }
    }

    // 피셔-예이츠 셔플
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    return deck;
  }

  // 카드 뽑기 (소켓에서 사용)
  drawCard(deck) {
    if (!deck || deck.length === 0) {
      console.error("[BlackjackService] 덱이 비어있습니다.");
      return null;
    }
    return deck.pop();
  }

  // 카드 값 계산 (블랙잭 규칙)
  calculateHandValue(hand) {
    let value = 0;
    let aces = 0;

    for (let card of hand) {
      if (card.value === "A") {
        aces++;
        value += 11;
      } else if (["J", "Q", "K", "0"].includes(card.value)) {
        value += 10;
      } else {
        value += parseInt(card.value);
      }
    }

    // 에이스 처리 (21을 넘지 않도록)
    while (value > 21 && aces > 0) {
      value -= 10;
      aces--;
    }

    return value;
  }

  // 단일 카드 값 계산 (소켓에서 사용)
  calculateCardValue(card) {
    if (!card || !card.value) return 0;

    if (card.value === "A") {
      return 11; // 기본값 11, 나중에 조정
    } else if (["J", "Q", "K", "0"].includes(card.value)) {
      return 10;
    } else {
      return parseInt(card.value) || 0;
    }
  }

  // 베팅 처리 (간소화)
  placeBet(userId, amount) {
    const session = this.getGameSession(userId);
    if (!session) {
      return { success: false, message: "게임 세션을 찾을 수 없습니다." };
    }

    if (session.status !== "waiting" && session.status !== "finished") {
      return { success: false, message: "베팅할 수 있는 상태가 아닙니다." };
    }

    if (amount <= 0) {
      return { success: false, message: "베팅 금액이 올바르지 않습니다." };
    }

    // 잔액 확인
    if (session.balance < amount) {
      return { success: false, message: "잔고가 부족합니다." };
    }

    // 기존 베팅이 있으면 반환
    if (session.currentBet > 0) {
      session.balance += session.currentBet;
    }

    // 게임 상태 초기화 (finished에서 베팅하는 경우)
    if (session.playerHand.length > 0 || session.dealerHand.length > 0) {
      this.prepareForNextGame(session);
    }

    // 새 베팅 차감
    session.balance -= amount;
    session.currentBet = amount;
    session.status = "betting";
    session.lastActivity = new Date();

    return {
      success: true,
      message: "베팅이 완료되었습니다.",
      session: this.getSessionData(session),
      additionalAmount: amount, // 실제 차감된 금액
    };
  }

  // 게임 시작 (카드 딜링)
  startGame(userId) {
    const session = this.getGameSession(userId);
    if (!session) {
      return { success: false, message: "게임 세션을 찾을 수 없습니다." };
    }

    if (session.status !== "betting" || session.currentBet === 0) {
      return { success: false, message: "먼저 베팅을 해주세요." };
    }

    // 게임 초기화
    session.playerHand = [];
    session.dealerHand = [];
    session.splitHands = [];
    session.currentHandIndex = 0;
    session.isSplit = false;
    session.handResults = [];
    session.totalPayout = 0;
    session.canDouble = false;
    session.canSplit = false;
    session.canInsurance = false;
    session.gameStartTime = new Date();
    session.status = "dealing";

    // 덱이 부족하면 새로 생성
    if (session.deck.length < 20) {
      session.deck = this.createAndShuffleDeck();
    }

    // 초기 카드 딜링 (플레이어 2장, 딜러 2장 - 딜러 첫 카드는 숨김)
    session.playerHand.push(this.drawCard(session.deck));
    session.dealerHand.push(this.drawCard(session.deck)); // 숨겨진 카드
    session.playerHand.push(this.drawCard(session.deck));
    session.dealerHand.push(this.drawCard(session.deck)); // 보이는 카드

    // 플레이어 핸드 값 계산
    const playerValue = this.calculateHandValue(session.playerHand);
    const dealerUpCard = session.dealerHand[1]; // 딜러의 보이는 카드

    // 정상 게임 진행 (블랙잭 체크는 클라이언트에서 카드 표시 후 처리)
    session.status = "playing";

    // 더블다운 가능 여부 (첫 두 카드)
    session.canDouble = session.balance >= session.currentBet;

    // 스플릿 가능 여부 (같은 값의 카드)
    const card1Value = this.getCardNumericValue(session.playerHand[0]);
    const card2Value = this.getCardNumericValue(session.playerHand[1]);
    session.canSplit =
      card1Value === card2Value && session.balance >= session.currentBet;

    // 보험 가능 여부 (딜러 업카드가 A)
    session.canInsurance =
      dealerUpCard.value === "A" &&
      session.balance >= Math.floor(session.currentBet / 2);

    // 블랙잭 체크를 위한 정보 추가
    session.playerValue = playerValue;
    session.dealerValue = this.calculateHandValue(session.dealerHand);
    session.playerBlackjack = playerValue === 21;
    session.dealerBlackjack = session.dealerValue === 21;

    session.lastActivity = new Date();

    return {
      success: true,
      message: "게임이 시작되었습니다.",
      session: this.getSessionData(session),
      needsBlackjackCheck: true, // 클라이언트에서 블랙잭 체크 필요
    };
  }

  // 카드의 숫자 값 반환 (스플릿 판단용)
  getCardNumericValue(card) {
    if (["J", "Q", "K", "0"].includes(card.value)) {
      return 10;
    } else if (card.value === "A") {
      return 1; // 스플릿 판단에서는 A를 1로 취급
    } else {
      return parseInt(card.value);
    }
  }

  // 블랙잭 체크 및 처리
  checkBlackjack(userId) {
    const session = this.getGameSession(userId);
    if (!session) {
      return { success: false, message: "게임 세션을 찾을 수 없습니다." };
    }

    if (session.status !== "playing") {
      return {
        success: false,
        message: "블랙잭 체크할 수 있는 상태가 아닙니다.",
      };
    }

    const playerValue = this.calculateHandValue(session.playerHand);
    const dealerValue = this.calculateHandValue(session.dealerHand);
    const playerBlackjack = playerValue === 21;
    const dealerBlackjack = dealerValue === 21;

    if (playerBlackjack || dealerBlackjack) {
      // 블랙잭이 있으면 게임 종료
      session.status = "finished";
      session.gameEndTime = new Date();

      if (playerBlackjack && dealerBlackjack) {
        // 둘 다 블랙잭 - 푸시
        session.handResults.push({
          result: "push",
          payout: session.currentBet,
        });
        session.totalPayout = session.currentBet;
        session.balance += session.currentBet;
      } else if (playerBlackjack) {
        // 플레이어 블랙잭 - 1.5배 지급
        const payout = Math.floor(session.currentBet * 2.5);
        session.handResults.push({ result: "blackjack", payout });
        session.totalPayout = payout;
        session.balance += payout;
      } else {
        // 딜러 블랙잭 - 플레이어 패배
        session.handResults.push({ result: "lose", payout: 0 });
        session.totalPayout = 0;
      }

      return {
        success: true,
        isBlackjack: true,
        playerBlackjack,
        dealerBlackjack,
        session: this.getSessionData(session),
      };
    }

    return {
      success: true,
      isBlackjack: false,
      session: this.getSessionData(session),
    };
  }

  // 히트 (카드 추가)
  hit(userId) {
    const session = this.getGameSession(userId);
    if (!session) {
      return { success: false, message: "게임 세션을 찾을 수 없습니다." };
    }

    if (session.status !== "playing") {
      return {
        success: false,
        message: "카드를 받을 수 있는 상태가 아닙니다.",
      };
    }

    // 현재 핸드 가져오기
    const currentHand = session.isSplit
      ? session.splitHands[session.currentHandIndex]
      : session.playerHand;

    // 카드 추가
    const newCard = this.drawCard(session.deck);
    if (!newCard) {
      return { success: false, message: "카드가 부족합니다." };
    }

    currentHand.push(newCard);
    const handValue = this.calculateHandValue(currentHand);

    // 더블다운 불가능하게 변경 (3장째부터)
    session.canDouble = false;

    // 21이면 자동 스탠드
    if (handValue === 21) {
      return this.stand(userId);
    }

    if (handValue > 21) {
      // 버스트 - 즉시 게임 종료
      session.status = "finished";
      session.gameEndTime = new Date();
      session.handResults.push({ result: "bust", payout: 0 });
      session.totalPayout = 0;

      return {
        success: true,
        message: "버스트! 게임이 종료되었습니다.",
        newCard,
        handValue,
        session: this.getSessionData(session),
        isBust: true, // 버스트 플래그 추가
      };
    }

    session.lastActivity = new Date();

    return {
      success: true,
      message: handValue > 21 ? "버스트!" : "카드를 받았습니다.",
      newCard,
      handValue,
      session: this.getSessionData(session),
    };
  }

  // 스탠드 (카드 받기 중단)
  stand(userId) {
    const session = this.getGameSession(userId);
    if (!session) {
      return { success: false, message: "게임 세션을 찾을 수 없습니다." };
    }

    if (session.status !== "playing") {
      return { success: false, message: "스탠드할 수 있는 상태가 아닙니다." };
    }

    if (session.isSplit) {
      // 스플릿 중인 경우 현재 핸드 완료
      this.finishCurrentSplitHand(session, "stand");
    } else {
      // 일반 게임에서 스탠드 - 딜러 턴으로
      session.status = "dealer-turn";
      this.dealerPlay(session);
    }

    session.lastActivity = new Date();

    return {
      success: true,
      message: "스탠드했습니다.",
      session: this.getSessionData(session),
    };
  }

  // 더블다운
  double(userId) {
    const session = this.getGameSession(userId);
    if (!session) {
      return { success: false, message: "게임 세션을 찾을 수 없습니다." };
    }

    if (session.status !== "playing" || !session.canDouble) {
      return { success: false, message: "더블다운할 수 있는 상태가 아닙니다." };
    }

    if (session.balance < session.currentBet) {
      return { success: false, message: "더블다운을 위한 잔고가 부족합니다." };
    }

    // 베팅 금액 두 배로
    session.balance -= session.currentBet;
    session.currentBet *= 2;
    session.canDouble = false;

    // 카드 한 장만 더 받고 자동 스탠드
    const hitResult = this.hit(userId);
    if (hitResult.success && session.status === "playing") {
      // 버스트가 아니면 자동 스탠드
      setTimeout(() => this.stand(userId), 100);
    }

    return {
      success: true,
      message: "더블다운했습니다.",
      session: this.getSessionData(session),
    };
  }

  // 보험 처리
  insurance(userId) {
    const session = this.getGameSession(userId);
    if (!session) {
      return { success: false, message: "게임 세션을 찾을 수 없습니다." };
    }

    if (session.status !== "playing" || !session.canInsurance) {
      return { success: false, message: "보험을 걸 수 있는 상태가 아닙니다." };
    }

    const insuranceAmount = Math.floor(session.currentBet / 2);
    if (session.balance < insuranceAmount) {
      return { success: false, message: "보험을 위한 잔고가 부족합니다." };
    }

    // 보험 베팅 처리
    session.balance -= insuranceAmount;
    session.insuranceBet = insuranceAmount;
    session.canInsurance = false;
    session.lastActivity = new Date();

    return {
      success: true,
      message: "보험을 걸었습니다.",
      session: this.getSessionData(session),
      insuranceAmount: insuranceAmount,
    };
  }

  // 스플릿 처리
  split(userId) {
    const session = this.getGameSession(userId);
    if (!session) {
      return { success: false, message: "게임 세션을 찾을 수 없습니다." };
    }

    if (session.status !== "playing" || !session.canSplit) {
      return { success: false, message: "스플릿할 수 있는 상태가 아닙니다." };
    }

    if (session.balance < session.currentBet) {
      return { success: false, message: "스플릿을 위한 잔고가 부족합니다." };
    }

    // 스플릿 실행
    session.balance -= session.currentBet; // 추가 베팅
    session.isSplit = true;
    session.canSplit = false;
    session.canDouble = false; // 스플릿 후에는 더블다운 불가
    session.currentHandIndex = 0;

    // 두 번째 카드를 분리하여 새로운 핸드 생성
    const secondCard = session.playerHand.pop();
    session.splitHands = [
      [...session.playerHand], // 첫 번째 핸드 (첫 번째 카드만)
      [secondCard], // 두 번째 핸드 (두 번째 카드만)
    ];

    // 각 핸드에 새 카드 추가
    const newCard1 = this.drawCard(session.deck);
    const newCard2 = this.drawCard(session.deck);

    if (!newCard1 || !newCard2) {
      return { success: false, message: "카드가 부족합니다." };
    }

    session.splitHands[0].push(newCard1);
    session.splitHands[1].push(newCard2);

    // 플레이어 핸드를 첫 번째 스플릿 핸드로 설정
    session.playerHand = [...session.splitHands[0]];

    session.lastActivity = new Date();

    return {
      success: true,
      message: "스플릿했습니다. 첫 번째 핸드부터 플레이합니다.",
      session: this.getSessionData(session),
      additionalBet: session.currentBet,
    };
  }

  // 딜러 플레이 (소켓에서 단계별로 처리하므로 여기서는 상태만 변경)
  dealerPlay(session) {
    session.status = "dealer-turn";
    // 실제 카드 처리는 소켓에서 단계별로 수행
  }

  // 게임 결과 결정 (게임 데이터 보존을 위해 수정)
  determineGameResult(session) {
    const dealerValue = this.calculateHandValue(session.dealerHand);
    const dealerBusted = dealerValue > 21;
    const dealerBlackjack =
      dealerValue === 21 && session.dealerHand.length === 2;

    // 보험 처리
    if (session.insuranceBet > 0) {
      if (dealerBlackjack) {
        const insurancePayout = session.insuranceBet * 3;
        session.balance += insurancePayout;
        session.totalPayout += insurancePayout;
      } else {
      }
    }

    let gameResults = [];

    if (session.isSplit) {
      // 스플릿 게임 결과 처리
      session.totalPayout = 0;

      for (let i = 0; i < session.splitHands.length; i++) {
        const hand = session.splitHands[i];
        const handValue = this.calculateHandValue(hand);
        let result, payout;

        if (handValue > 21) {
          result = "bust";
          payout = 0;
        } else if (dealerBusted || handValue > dealerValue) {
          result = "win";
          payout = session.currentBet; // 스플릿에서는 각 핸드당 원래 베팅액
        } else if (handValue < dealerValue) {
          result = "lose";
          payout = 0;
        } else {
          result = "push";
          payout = session.currentBet / 2; // 스플릿에서는 절반씩
        }

        const handResult = { result, payout, handValue, hand };
        session.handResults[i] = handResult;
        gameResults.push(handResult);
        session.totalPayout += payout;
      }
    } else {
      // 일반 게임 결과 처리
      const playerValue = this.calculateHandValue(session.playerHand);
      const playerBlackjack =
        playerValue === 21 && session.playerHand.length === 2;
      let result, payout;

      if (playerValue > 21) {
        result = "bust";
        payout = 0;
      } else if (playerBlackjack && !dealerBlackjack) {
        result = "blackjack";
        payout = Math.floor(session.currentBet * 2.5); // 블랙잭은 3:2 배당
      } else if (dealerBusted || playerValue > dealerValue) {
        result = "win";
        payout = session.currentBet * 2; // 원래 베팅액의 2배
      } else if (playerValue < dealerValue) {
        result = "lose";
        payout = 0;
      } else {
        result = "push";
        payout = session.currentBet; // 베팅액 반환
      }

      const handResult = {
        result,
        payout,
        handValue: playerValue,
        hand: session.playerHand,
      };

      session.handResults.push(handResult);
      gameResults.push(handResult);
      session.totalPayout += payout;
    }

    // 잔고 업데이트
    session.balance += session.totalPayout;
    session.status = "finished";
    session.gameEndTime = new Date();

    // gameStartTime이 null인 경우 현재 시간으로 설정 (오류 방지)
    if (!session.gameStartTime) {
      session.gameStartTime = new Date(Date.now() - 60000); // 1분 전으로 설정
      console.warn(
        `[BlackjackService] gameStartTime이 null이어서 기본값으로 설정됨`
      );
    }

    // 게임 결과 반환 (상태 초기화는 나중에 처리)
    return gameResults;
  }

  // 다음 게임을 위한 상태 초기화 준비
  prepareForNextGame(session) {
    // 게임 관련 상태만 초기화 (잔액과 기본 정보는 유지)
    session.playerHand = [];
    session.dealerHand = [];
    session.splitHands = [];
    session.currentHandIndex = 0;
    session.isSplit = false;
    session.currentBet = 0;
    session.insuranceBet = 0;
    session.canDouble = false;
    session.canSplit = false;
    session.canInsurance = false;
    session.handResults = [];
    session.totalPayout = 0;
    // gameStartTime과 gameEndTime은 다음 게임 시작 시 새로 설정
    session.gameStartTime = null;
    session.gameEndTime = null;
    session.playerBlackjack = false;
    session.dealerBlackjack = false;
    session.hasDoubled = false;

    // 딜러 턴 관련 정리
    if (session.dealerTurnTimeout) {
      clearTimeout(session.dealerTurnTimeout);
      delete session.dealerTurnTimeout;
    }

    // 덱이 부족하면 새로 생성
    if (session.deck.length < 20) {
      session.deck = this.createAndShuffleDeck();
    }

    session.lastActivity = new Date();
  }

  // 스플릿 핸드 완료 처리
  finishCurrentSplitHand(session, result) {
    const currentHand = session.splitHands[session.currentHandIndex];
    const handValue = this.calculateHandValue(currentHand);

    // 결과 저장 (임시)
    session.handResults[session.currentHandIndex] = {
      result,
      handValue,
      hand: [...currentHand],
    };

    // 다음 핸드로 이동
    session.currentHandIndex++;

    if (session.currentHandIndex >= session.splitHands.length) {
      // 모든 스플릿 핸드 완료 - 딜러 턴
      session.status = "dealer-turn";
      this.dealerPlay(session);
    }
  }

  // 새 게임 시작
  newGame(userId) {
    const session = this.getGameSession(userId);
    if (!session) {
      return { success: false, message: "게임 세션을 찾을 수 없습니다." };
    }

    // 게임 상태 완전 초기화
    this.prepareForNextGame(session);
    session.status = "waiting";

    return {
      success: true,
      message: "새 게임을 시작할 수 있습니다.",
      session: this.getSessionData(session),
    };
  }

  // 세션 데이터 반환 (클라이언트 전송용)
  getSessionData(session) {
    // 딜러 핸드 처리 개선
    let dealerHandForClient;
    if (session.status === "finished") {
      // 게임 종료 시 모든 카드 공개
      dealerHandForClient = session.dealerHand;
    } else {
      // 게임 진행 중에는 첫 번째 카드만 숨김
      dealerHandForClient = session.dealerHand.map((card, index) => {
        if (index === 0) {
          // 첫 번째 카드는 숨김 처리하지만 실제 정보는 유지
          return {
            value: "hidden",
            suit: "hidden",
            actualValue: card.value,
            actualSuit: card.suit,
          };
        }
        return card;
      });
    }

    return {
      sessionId: session.sessionId,
      userId: session.userId,
      username: session.username,
      balance: session.balance,
      status: session.status,
      playerHand: session.playerHand,
      dealerHand: dealerHandForClient,
      currentBet: session.currentBet,
      insuranceBet: session.insuranceBet,
      canDouble: session.canDouble,
      canSplit: session.canSplit,
      canInsurance: session.canInsurance,
      isSplit: session.isSplit,
      splitHands: session.splitHands,
      currentHandIndex: session.currentHandIndex,
      handResults: session.handResults,
      totalPayout: session.totalPayout,
      playerValue:
        session.playerHand.length > 0
          ? this.calculateHandValue(session.playerHand)
          : 0,
      dealerValue:
        session.status === "finished"
          ? this.calculateHandValue(session.dealerHand)
          : session.dealerHand.length > 1
          ? this.calculateHandValue([session.dealerHand[1]])
          : 0,
      gameStartTime: session.gameStartTime,
      gameEndTime: session.gameEndTime,
    };
  }

  // 모든 세션 정리 (주기적 정리용)
  cleanupInactiveSessions() {
    const now = new Date();
    const maxInactiveTime = 30 * 60 * 1000; // 30분

    for (let [userId, session] of this.gameSessions) {
      if (now - session.lastActivity > maxInactiveTime) {
        this.gameSessions.delete(userId);
      }
    }
  }

  // 활성 세션 수 반환
  getActiveSessionCount() {
    return this.gameSessions.size;
  }
}

module.exports = BlackjackService;
