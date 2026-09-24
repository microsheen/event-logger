import express from 'express';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// 这个进程只做两件事：发静态文件、在旧版 data.json 还在本机时提供一次只读探测。
// 用户的 event / template / 历史版本全部写在浏览器的 IndexedDB 里，服务器不落一个字节。
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3002; // 默认 3002：与 vite.config.js 的 proxy、*.bat、design.md 一致；*.bat 也跟随 PORT
const DIST = resolve(__dirname, 'dist');
const LEGACY_DATA_FILE = resolve(__dirname, 'data.json');

// 只读：给「首启引导 → 导入本机旧数据」用。公网部署没有 data.json，404 即前端自动隐藏该入口。
app.get('/api/legacy-data', (req, res) => {
  if (!existsSync(LEGACY_DATA_FILE)) {
    return res.status(404).json({ error: 'no legacy data' });
  }
  try {
    res.type('application/json').send(readFileSync(LEGACY_DATA_FILE));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(DIST));

app.get('*', (req, res) => {
  res.sendFile(resolve(DIST, 'index.html'));
});

app.listen(PORT, () => {
  console.log('Event Logger (static-only) server running on http://localhost:' + PORT);
});