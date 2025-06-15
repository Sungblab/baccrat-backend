const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const config = require("./config/config");
const socketHandler = require("./sockets/socket.handler");
const BaccaratGame = require("./services/baccarat.service");
const BlackjackSocket = require("./sockets/blackjack.socket");

// Routes
const authRoutes = require("./routes/auth.routes");
const adminRoutesFactory = require("./routes/admin.routes");
const userRoutes = require("./routes/user.routes");
const transactionRoutesFactory = require("./routes/transaction.routes");
const chatRoutes = require("./routes/chat.routes");
const gameRoutes = require("./routes/game.routes");

// Initialization
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [config.FRONTEND_URL, config.LOCAL_DEV_URL],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  },
});

// Baccarat Game Instance
const baccaratGame = new BaccaratGame();

// Blackjack Socket Instance
const blackjackSocket = new BlackjackSocket(io);

// User sockets map for real-time communication
const userSockets = new Map();

// Socket.IO Handler
io.on("connection", (socket) => {
  // 바카라와 블랙잭 소켓 핸들러 분리
  socketHandler(io, baccaratGame, userSockets, socket);
  blackjackSocket.handleConnection(socket);
});

// Create admin routes with io and userSockets
const adminRoutes = adminRoutesFactory(io, userSockets);

// Create transaction routes with io and userSockets
const transactionRoutes = transactionRoutesFactory(io, userSockets);

// Middleware
app.use(
  cors({
    origin: [config.FRONTEND_URL, config.LOCAL_DEV_URL],
    credentials: true,
  })
);

// 한글 지원을 위한 문자 인코딩 설정
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/game", gameRoutes);

// Transaction routes
app.use("/api", transactionRoutes);

// Legacy API routes for compatibility
app.get("/api/recent-games", async (req, res) => {
  try {
    const Game = require("./models/game.model");
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

// Root Route
app.get("/", (req, res) => {
  res.send("Baccarat Game Backend Running");
});

// Start Server
const PORT = process.env.PORT || 5000;

mongoose
  .connect(config.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("MongoDB Connected...");
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Frontend URL: ${config.FRONTEND_URL}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB", err);
    process.exit(1);
  });

module.exports = { app, server, io };
