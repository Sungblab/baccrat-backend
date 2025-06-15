function calculateProfit(bet) {
  try {
    if (bet.result === "win") {
      if (bet.choice === "player") {
        return bet.amount; // 플레이어 승리: 베팅액 1배 수익 (총 2배 지급)
      } else if (bet.choice === "banker") {
        return bet.amount * 0.95; // 뱅커 승리: 베팅액 0.95배 수익 (총 1.95배 지급)
      } else if (bet.choice === "tie") {
        return bet.amount * 8; // 타이 승리: 베팅액 8배 수익 (총 9배 지급)
      } else if (bet.choice === "player_pair" || bet.choice === "banker_pair") {
        return bet.amount * 11; // 페어 승리: 베팅액 11배 수익 (총 12배 지급)
      }
    } else if (bet.result === "draw") {
      return 0; // 무승부: 원금 반환이므로 손익 0
    } else if (bet.result === "lose") {
      return -bet.amount; // 패배: 베팅액만큼 손실
    }
    return 0;
  } catch (error) {
    return 0;
  }
}

module.exports = {
  calculateProfit,
};
