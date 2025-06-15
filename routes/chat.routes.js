const express = require("express");
const User = require("../models/user.model");
const Chat = require("../models/chat.model");
const auth = require("../middleware/auth.middleware");

const router = express.Router();

module.exports = (io) => {
  // Get chat messages
  router.get("/messages", auth(), async (req, res) => {
    try {
      const messages = await Chat.find()
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
      const sortedMessages = messages.reverse();
      res.json(sortedMessages);
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  // Send chat message
  router.post("/send", auth(), async (req, res) => {
    try {
      const { message } = req.body;
      if (!message || message.trim() === "" || message.length > 500) {
        return res
          .status(400)
          .json({ message: "메시지가 비어있거나 500자를 초과합니다." });
      }
      const user = await User.findById(req.user.id).select("username role");
      if (!user) {
        return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
      }
      const isAdmin = user.role === "admin";
      const chatMessage = new Chat({
        userId: user._id,
        username: user.username,
        message: message.trim(),
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
      res.json({ message: "채팅이 전송되었습니다." });
    } catch (err) {
      res.status(500).json({ message: "서버 에러" });
    }
  });

  return router;
};
