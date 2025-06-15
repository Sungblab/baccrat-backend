require("dotenv").config();

module.exports = {
  JWT_SECRET: process.env.JWT_SECRET || "your_jwt_secret",
  MONGO_URI:
    process.env.MONGO_URI ||
    "mongodb://localhost:27017/betting_game?retryWrites=true&w=majority",
  FRONTEND_URL: process.env.FRONTEND_URL || "https://goldbac.netlify.app",
  LOCAL_DEV_URL: process.env.LOCAL_DEV_URL || "http://127.0.0.1:5500",
};
