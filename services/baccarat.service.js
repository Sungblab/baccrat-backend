class BaccaratGame {
  constructor() {
    this.deck = [];
    this.numberOfDecks = 8;
    this.reshufflePoint = 52 * 2;
    this.initializeDeck();
    this.shuffleDeck();
  }

  initializeDeck() {
    const suits = ["H", "D", "C", "S"]; // Hearts, Diamonds, Clubs, Spades
    const values = [
      "A",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "0", // 10을 0으로 표현 (deckofcardsapi.com 형식)
      "J",
      "Q",
      "K",
    ];
    this.deck = [];

    for (let d = 0; d < this.numberOfDecks; d++) {
      for (let suit of suits) {
        for (let value of values) {
          this.deck.push({ suit, value, id: `${value}${suit}_${d}` });
        }
      }
    }
  }

  shuffleDeck() {
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  drawCard() {
    if (this.deck.length < this.reshufflePoint) {
      this.initializeDeck();
      this.shuffleDeck();
    }
    return this.deck.pop();
  }

  getCardValue(card) {
    if (["J", "Q", "K", "0"].includes(card.value)) return 0; // "T" 대신 "0" 사용
    if (card.value === "A") return 1;
    return parseInt(card.value);
  }

  calculateHandValue(hand) {
    let value = 0;
    let calculation = [];

    for (let card of hand) {
      const cardValue = this.getCardValue(card);
      value = (value + cardValue) % 10;
      calculation.push(cardValue);
    }

    return {
      total: value,
      calculation: calculation.join(" + "),
      cards: hand,
    };
  }

  shouldBankerDraw(bankerScore, playerThirdCard) {
    if (bankerScore <= 2) return true;
    if (bankerScore >= 7) return false;
    if (!playerThirdCard) return bankerScore <= 5;

    const playerThirdValue = this.getCardValue(playerThirdCard);

    switch (bankerScore) {
      case 3:
        return playerThirdValue !== 8;
      case 4:
        return [2, 3, 4, 5, 6, 7].includes(playerThirdValue);
      case 5:
        return [4, 5, 6, 7].includes(playerThirdValue);
      case 6:
        return [6, 7].includes(playerThirdValue);
      default:
        return false;
    }
  }

  checkPairs(playerHand, bankerHand) {
    let playerPair = false;
    let bankerPair = false;

    if (playerHand.length >= 2) {
      const card1Value = this.getCardValue(playerHand[0]);
      const card2Value = this.getCardValue(playerHand[1]);
      playerPair = card1Value === card2Value;
    }

    if (bankerHand.length >= 2) {
      const card1Value = this.getCardValue(bankerHand[0]);
      const card2Value = this.getCardValue(bankerHand[1]);
      bankerPair = card1Value === card2Value;
    }

    return { playerPair, bankerPair };
  }

  playGame() {
    const playerHand = [];
    const bankerHand = [];

    // 초기 2장씩 배분
    playerHand.push(this.drawCard());
    bankerHand.push(this.drawCard());
    playerHand.push(this.drawCard());
    bankerHand.push(this.drawCard());

    const playerScore = this.calculateHandValue(playerHand);
    const bankerScore = this.calculateHandValue(bankerHand);

    // 내추럴 체크 (8 또는 9)
    if (playerScore.total >= 8 || bankerScore.total >= 8) {
      const { playerPair, bankerPair } = this.checkPairs(
        playerHand,
        bankerHand
      );
      return this.getGameResult(playerHand, bankerHand, playerPair, bankerPair);
    }

    // 플레이어 세 번째 카드 (5 이하일 때 받음)
    let playerThirdCard = null;
    if (playerScore.total <= 5) {
      playerThirdCard = this.drawCard();
      playerHand.push(playerThirdCard);
    }

    // 뱅커 세 번째 카드 (수정된 바카라 규칙 적용)
    const currentBankerScore = this.calculateHandValue(bankerHand);
    if (this.shouldBankerDraw(currentBankerScore.total, playerThirdCard)) {
      bankerHand.push(this.drawCard());
    }

    const { playerPair, bankerPair } = this.checkPairs(playerHand, bankerHand);
    return this.getGameResult(playerHand, bankerHand, playerPair, bankerPair);
  }

  getGameResult(playerHand, bankerHand, playerPair, bankerPair) {
    const finalPlayerScore = this.calculateHandValue(playerHand);
    const finalBankerScore = this.calculateHandValue(bankerHand);

    let result;
    if (finalPlayerScore.total > finalBankerScore.total) {
      result = "player";
    } else if (finalPlayerScore.total < finalBankerScore.total) {
      result = "banker";
    } else {
      result = "tie";
    }

    return {
      result,
      playerScore: finalPlayerScore.total,
      bankerScore: finalBankerScore.total,
      playerHand: finalPlayerScore,
      bankerHand: finalBankerScore,
      playerPairOccurred: playerPair,
      bankerPairOccurred: bankerPair,
      timestamp: new Date().toISOString(),
    };
  }

  getDeckInfo() {
    const remainingCards = this.deck.length;
    const remainingDecks = (remainingCards / 52).toFixed(1);
    return { remainingCards, remainingDecks };
  }

  // 승부 조작을 위한 특정 결과 생성 메서드
  playFixedGame(fixedResult) {
    const playerHand = [];
    const bankerHand = [];

    // 패턴 번호 추출 (예: "player_1", "banker_2", "tie_3")
    const [result, patternNum] = fixedResult.split("_");
    const pattern = parseInt(patternNum) || 1;

    // 원하는 결과에 따라 미리 계산된 카드 조합 사용
    if (result === "player") {
      this.setPlayerWinPattern(playerHand, bankerHand, pattern);
    } else if (result === "banker") {
      this.setBankerWinPattern(playerHand, bankerHand, pattern);
    } else if (result === "tie") {
      this.setTiePattern(playerHand, bankerHand, pattern);
    }

    const { playerPair, bankerPair } = this.checkPairs(playerHand, bankerHand);
    return this.getGameResult(playerHand, bankerHand, playerPair, bankerPair);
  }

  // 플레이어 승리 패턴들
  setPlayerWinPattern(playerHand, bankerHand, pattern) {
    switch (pattern) {
      case 1: // 내추럴 9 vs 8
        playerHand.push({ suit: "H", value: "9", id: "9H_p1" });
        playerHand.push({ suit: "D", value: "0", id: "0D_p1" });
        bankerHand.push({ suit: "C", value: "8", id: "8C_p1" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_p1" });
        break;
      case 2: // 세 번째 카드로 역전승
        playerHand.push({ suit: "H", value: "4", id: "4H_p2" });
        playerHand.push({ suit: "D", value: "2", id: "2D_p2" });
        playerHand.push({ suit: "S", value: "3", id: "3S_p2" }); // 6+3=9
        bankerHand.push({ suit: "C", value: "5", id: "5C_p2" });
        bankerHand.push({ suit: "H", value: "2", id: "2H_p2" }); // 7로 스탠드
        break;
      case 3: // 간발의 차이로 승리
        playerHand.push({ suit: "H", value: "6", id: "6H_p3" });
        playerHand.push({ suit: "D", value: "2", id: "2D_p3" }); // 8
        bankerHand.push({ suit: "C", value: "4", id: "4C_p3" });
        bankerHand.push({ suit: "S", value: "3", id: "3S_p3" }); // 7
        break;
      default:
        // 기본 패턴
        playerHand.push({ suit: "H", value: "9", id: "9H_default" });
        playerHand.push({ suit: "D", value: "0", id: "0D_default" });
        bankerHand.push({ suit: "C", value: "8", id: "8C_default" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_default" });
    }
  }

  // 뱅커 승리 패턴들
  setBankerWinPattern(playerHand, bankerHand, pattern) {
    switch (pattern) {
      case 1: // 내추럴 9 vs 8
        playerHand.push({ suit: "H", value: "8", id: "8H_b1" });
        playerHand.push({ suit: "D", value: "0", id: "0D_b1" });
        bankerHand.push({ suit: "C", value: "9", id: "9C_b1" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_b1" });
        break;
      case 2: // 뱅커 룰에 의한 승리
        playerHand.push({ suit: "H", value: "3", id: "3H_b2" });
        playerHand.push({ suit: "D", value: "2", id: "2D_b2" });
        playerHand.push({ suit: "S", value: "4", id: "4S_b2" }); // 5+4=9
        bankerHand.push({ suit: "C", value: "6", id: "6C_b2" });
        bankerHand.push({ suit: "H", value: "3", id: "3H_b2" });
        bankerHand.push({ suit: "D", value: "A", id: "AD_b2" }); // 9+1=0 (10)
        break;
      case 3: // 압도적 승리
        playerHand.push({ suit: "H", value: "2", id: "2H_b3" });
        playerHand.push({ suit: "D", value: "3", id: "3D_b3" }); // 5
        bankerHand.push({ suit: "C", value: "7", id: "7C_b3" });
        bankerHand.push({ suit: "S", value: "2", id: "2S_b3" }); // 9
        break;
      default:
        // 기본 패턴
        playerHand.push({ suit: "H", value: "7", id: "7H_default" });
        playerHand.push({ suit: "D", value: "0", id: "0D_default" });
        bankerHand.push({ suit: "C", value: "9", id: "9C_default" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_default" });
    }
  }

  // 타이 패턴들
  setTiePattern(playerHand, bankerHand, pattern) {
    switch (pattern) {
      case 1: // 내추럴 8 타이
        playerHand.push({ suit: "H", value: "8", id: "8H_t1" });
        playerHand.push({ suit: "D", value: "0", id: "0D_t1" });
        bankerHand.push({ suit: "C", value: "8", id: "8C_t1" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_t1" });
        break;
      case 2: // 세 번째 카드 후 타이
        playerHand.push({ suit: "H", value: "2", id: "2H_t2" });
        playerHand.push({ suit: "D", value: "4", id: "4D_t2" });
        playerHand.push({ suit: "S", value: "A", id: "AS_t2" }); // 6+1=7
        bankerHand.push({ suit: "C", value: "5", id: "5C_t2" });
        bankerHand.push({ suit: "H", value: "A", id: "AH_t2" });
        bankerHand.push({ suit: "D", value: "A", id: "AD_t2" }); // 6+1=7
        break;
      case 3: // 낮은 점수 타이
        playerHand.push({ suit: "H", value: "3", id: "3H_t3" });
        playerHand.push({ suit: "D", value: "0", id: "0D_t3" }); // 3
        bankerHand.push({ suit: "C", value: "2", id: "2C_t3" });
        bankerHand.push({ suit: "S", value: "A", id: "AS_t3" }); // 3
        break;
      default:
        // 기본 패턴
        playerHand.push({ suit: "H", value: "8", id: "8H_default" });
        playerHand.push({ suit: "D", value: "0", id: "0D_default" });
        bankerHand.push({ suit: "C", value: "8", id: "8C_default" });
        bankerHand.push({ suit: "S", value: "0", id: "0S_default" });
    }
  }
}

module.exports = BaccaratGame;
