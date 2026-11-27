import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("FLYING ARROW AI BOT is running! ❤️");
});

app.listen(PORT, () => {
  console.log(`FLYING ARROW BOT running on port ${PORT}`);
});
