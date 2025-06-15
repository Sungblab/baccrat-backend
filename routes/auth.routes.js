const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const auth = require("../middleware/auth.middleware");
const { JWT_SECRET } = require("../config/config");

const router = express.Router();

// @route   POST api/auth/register
// @desc    Register user
// @access  Public
router.post("/register", async (req, res) => {
  const { username, password } = req.body;

  try {
    let user = await User.findOne({ username });
    if (user) {
      return res.status(400).json({ message: "이미 존재하는 사용자입니다." });
    }

    user = new User({ username, password });

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    await user.save();

    res.json({ message: "회원가입이 완료되었습니다. 승인이 필요합니다." });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// @route   POST api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    let user = await User.findOne({ username });
    if (!user) {
      return res.status(400).json({ message: "사용자를 찾을 수 없습니다." });
    }

    if (!user.isApproved) {
      return res.status(403).json({ message: "관리자의 승인이 필요합니다." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "잘못된 비밀번호입니다." });
    }

    // 마지막 로그인 시간 업데이트
    user.lastLogin = new Date();
    await user.save();

    // JWT 페이로드 생성 (한글 지원)
    const payload = {
      id: user._id,
      role: user.role,
      username: user.username,
    };

    // JWT 토큰 생성 시 한글 지원을 위한 옵션 추가
    const token = jwt.sign(payload, JWT_SECRET, {
      expiresIn: "30d",
      algorithm: "HS256",
    });

    res.json({ token });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

// @route   GET api/auth/user-info
// @desc    Get user information
// @access  Private
router.get("/user-info", auth(), async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    const rollingDeposit = user.rollingDeposit || 0;
    const rollingWagered = user.rollingWagered || 0;
    const rollingRequirement = rollingDeposit * 1.5;

    const maxExchangeAmount =
      rollingWagered >= rollingRequirement ? user.balance : 0;

    res.json({
      username: user.username,
      balance: user.balance,
      bettingHistory: user.bettingHistory,
      rollingDeposit: user.rollingDeposit || 0,
      rollingWagered: rollingWagered,
      maxExchangeAmount,
    });
  } catch (err) {
    res.status(500).json({ message: "서버 에러" });
  }
});

module.exports = router;
