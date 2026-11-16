# Char3D Converter · 2D → 3D 角色 / 物件引擎

上傳自己畫的 2D 圖片，轉換成可以放進 Web Game 的 **3D 三頭身角色** 或 **3D 物件**，並匯出成遊戲可用的檔案。
純前端靜態網頁（three.js），所有轉換都在瀏覽器內完成，圖片不會上傳到任何伺服器。

**線上版：** `https://dot7dot.github.io/char-3d-converter-/`

## 功能

- **三頭身角色**：頭 : 胸 : 腳 = 1 : 1 : 1，另有手臂；沒上傳的身體部位以預設形狀顯示。
- **每個部位 / 配件都有獨立上傳區**，且每個都支援 **正面 / 側面 / 背面 / 頂部** 四個視圖：
  - 身體：頭部、胸部（軀幹）、手臂（自動左右鏡像）、腳（下半身，可左右腿分開）
  - 配件：帽子、臉部配件、背部配件、右手持物、左手持物、腰部配件、鞋子（自動成對）
  - 物件模式：任何單一道具 / 物件
- **2D → 3D 轉換方式**（自動判斷，也可手動切換）：
  | 模式 | 適合 | 原理 |
  |---|---|---|
  | 膨脹 Inflate | 頭、身體、圓潤物件 | 依輪廓的局部粗細推算厚度（圓 → 球、細長 → 圓管） |
  | 擠出 Extrude | 武器、盾牌、翅膀、徽章 | 輪廓擠出成板狀並加圓角 |
  | 旋轉體 Revolve | 帽子、瓶罐、杯子 | 以正面輪廓繞垂直軸旋轉 |
  | 三視圖雕刻 3-View Carve | 任何有側面/頂部圖的物件 | 正面 ∩ 側面 (∩ 頂部) 輪廓雕刻並圓角化，深度完全依照你的設計 |
  | 平面 Plane | 髮絲、特效、紙片角色 | 雙面透明貼圖卡片 |
- 原圖會投影回 3D 表面（正面、背面、側面、頂部各自投影），輪廓描邊不會被拉長到側面。
- 自動去背（透明 PNG 或純色背景）、可調厚度、圓潤度、平滑、大小、位置、旋轉。
- 內建骨架節點與動畫：**Idle / Walk / Run / Jump / Wave**。
- 插槽（Sockets）：`Socket_Hat`、`Socket_Face`、`Socket_Back`、`Socket_Hand_R/L`、`Socket_Waist`、`Socket_Foot_R/L`，遊戲中可再掛載其他物件。

## 匯出格式

| 格式 | 說明 |
|---|---|
| **遊戲套件 ZIP**（推薦） | `character.glb` + `character.json` 描述檔 + `c3d-loader.js` 載入器 + `index.html` 可操作示範 + 貼圖 + 原始圖 + 專案檔 |
| GLB / glTF | 含貼圖、節點階層、動畫，Three.js / Babylon.js / PlayCanvas / Godot / Unity 通用 |
| OBJ + MTL | 靜態模型 + PNG 貼圖（Blender 等建模軟體） |
| STL | 3D 列印 |
| USDZ | Apple AR Quick Look |
| 2D Sprite Sheet | 8 方向 × 走路 4 格 PNG + JSON，給 2D / 俯視角遊戲 |
| 各部件分開 GLB | 每個部件 / 配件一個 GLB，可做換裝零件或獨立道具 |
| 專案檔 `.c3d.json` | 保存圖片與參數，之後可繼續編輯 |

座標規格：單位公尺、+Y 向上、正面朝 +Z、原點在腳底中央。

### 在遊戲中使用（three.js）

```js
import { loadCharacter } from './c3d-loader.js';
const hero = await loadCharacter('./character.glb');
scene.add(hero.object);
hero.play('Walk');
hero.attach('Socket_Hand_R', mySword);
// 每幀：hero.update(dt);
```

## 繪圖建議

1. 透明背景 PNG 最佳；純色背景會自動去背。
2. 每張圖只畫一個部位，置中。
3. 側面圖：角色面朝畫面**右側**；頂部圖：角色正面朝畫面**下方**。
4. 三視圖的上下邊界要對齊。
5. 不確定時先按「範例」看示範。

## 本機開發

```bash
python3 -m http.server 8000   # 然後開 http://localhost:8000
```

沒有建置步驟。three.js r170 已放在 `vendor/three/`（MIT License）。

## 檔案結構

```
index.html          介面
css/style.css       樣式（支援深色模式、手機版）
js/main.js          狀態、UI、預覽、匯出流程
js/imageproc.js     讀圖、去背、裁切、貼圖延展、輪廓距離場
js/converter.js     2D→3D 核心：距離場 → Surface Nets → 平滑 → 投影貼圖
js/surfacenets.js   等值面擷取
js/character.js     三頭身組裝、骨架節點、插槽、動畫
js/exporter.js      所有匯出格式與遊戲套件
js/samples.js       範例圖（程式繪製）
js/slots.js         部位 / 配件定義
```
