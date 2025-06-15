const express = require("express");
const Game = require("../models/game.model");
const auth = require("../middleware/auth.middleware");

const router = express.Router();

// @route   GET api/game/recent
// @desc    Get recent games (for public game history)
// @access  Public
router.get("/recent", async (req, res) => {
  try {
    const recentGames = await Game.find()
      .select(
        "result date stats totalBets playerCount playerPairOccurred bankerPairOccurred"
      )
      .sort({ date: -1 })
      .limit(36)
      .lean();

    res.json(recentGames);
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// @route   GET api/game/admin/recent-games
// @desc    Get recent games for admin (with more details)
// @access  Admin
router.get("/admin/recent-games", auth("admin"), async (req, res) => {
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

module.exports = router;
