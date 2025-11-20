# CodinGame Chrome Extension - Quick Setup Guide

## 🚀 Quick Start (5 minutes)

### Prerequisites
- ✅ VS Code with CodinGame extension installed
- ✅ Chrome browser

### Setup Steps

#### 1. Install Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right)
3. Click "Load unpacked"
4. Select the `chrome-extention/extension` folder
5. The CodinGame icon should appear in your extensions bar

#### 2. Get Authentication Token

1. Open VS Code
2. Open the Output panel: `View → Output` (or `Ctrl+Shift+U` / `Cmd+Shift+U`)
3. Select **"CodinGame"** from the dropdown
4. Find this line near the top:
   ```
   [BRIDGE] Auth token: 65a7cad4ab3a2d8a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b
   ```
5. **Copy the full 64-character token** (now fully displayed, no truncation)

#### 3. Configure Chrome Extension

1. Right-click the CodinGame extension icon in Chrome
2. Select **"Options"**
3. Paste your token into the "Authentication Token" field
4. Click **"Save Settings"**
5. Click **"Test Connection"** to verify

✅ You should see: "Connection successful! Authentication verified."

---

## 📝 Usage

### Syncing Code to Browser

1. Open your bot code in VS Code
2. Open a CodinGame IDE page in Chrome (e.g., any puzzle or clash)
3. In VS Code, run: `CodinGame: Sync Code to Browser`
   - Via Command Palette: `Ctrl+Shift+P` / `Cmd+Shift+P` → type "CodinGame: Sync"
   - Via Status Bar: Click the CodinGame icon
4. Your code appears in the browser editor instantly!

### Capturing Match Results

1. Code gets synced to browser ✅
2. Run matches in CodinGame (Play button)
3. Results are automatically captured
4. Data is saved to VS Code workspace: `.codingame/matches/`
5. View statistics: `CodinGame: Show Statistics`

---

## 🔍 Verification

### Check Connection Status

**In Chrome:**
- Click the CodinGame extension icon
- Should show "Connected ✓"
- Shows last sync time and pending captures

**In VS Code:**
- Check Output panel (select "CodinGame")
- Should see: `[BRIDGE] Authentication successful`
- Status bar shows connection indicator

---

## ⚠️ Troubleshooting

### "Authentication timeout" Error

**Cause:** Token is missing or incorrect

**Fix:**
1. Get fresh token from VS Code Output panel
2. Open Chrome extension options (right-click icon → Options)
3. Paste new token
4. Save and test

### "Connection timeout" Error

**Cause:** VS Code bridge not running

**Fix:**
1. Make sure VS Code is open
2. Verify CodinGame extension is activated
3. Check VS Code Output panel shows bridge started
4. Try restarting VS Code

### Token Keeps Failing

**Cause:** VS Code generates new token on each restart

**Fix:**
1. After restarting VS Code, copy the NEW token
2. Update in Chrome extension options
3. Save settings

### Code Not Syncing

**Checklist:**
1. ✓ Extensions connected (check status)
2. ✓ On a CodinGame IDE page (not home page)
3. ✓ Active file is open in VS Code
4. ✓ Language is supported (Python, JS, Java, C++, etc.)

### Matches Not Captured

**Checklist:**
1. ✓ Extensions connected
2. ✓ On CodinGame website
3. ✓ Match completed (not just started)
4. ✓ Check `.codingame/matches/` folder in VS Code workspace

---

## 🎯 Features

### ✅ What Works Now

- **Code Sync**: Local code → Browser editor
- **Match Capture**: Automatic result collection
- **Statistics Dashboard**: Win/loss tracking, analytics
- **Comment Stripping**: Optional (configure in VS Code)
- **Multiple Languages**: Python, JavaScript, Java, C++, C#, Rust, Go
- **Replay Links**: Quick access to match replays
- **Offline Resilience**: Queues data when disconnected

### 🚧 Known Limitations

- Token must be updated after VS Code restart
- Only works on localhost (security feature)
- Monaco editor detection may take a moment
- Some CodinGame pages may need refresh

---

## 📊 File Locations

### Chrome Extension
```
chrome-extention/extension/
├── background.js       # Main logic
├── content-script.js   # Page interaction
├── popup.html/js       # Extension popup
├── options.html/js     # Settings page
└── manifest.json       # Extension config
```

### VS Code Extension
```
.codingame/
└── matches/
    ├── WIN_0_12345.json
    ├── LOSE_1_67890.json
    └── ...
```

### Match File Format
```json
{
  "match_id": "12345",
  "result": "WIN",
  "order": 0,
  "timestamp": "2024-06-XX...",
  "opponent": "PlayerName",
  "logs": {
    "stdout": "Match output...",
    "stderr": ""
  }
}
```

---

## 🔄 Updating

### When VS Code Restarts

1. VS Code generates new auth token
2. Copy from Output panel
3. Update in Chrome options
4. Save → Test → Done

### When Chrome Restarts

- Token is saved in Chrome storage
- Auto-loads on startup
- No action needed ✅

### When Extensions Update

1. Reload Chrome extension: `chrome://extensions/` → Click reload
2. Restart VS Code (if needed)
3. Update token in Chrome options (if token changed)

---

## 💡 Tips & Tricks

### Speed Up Token Updates

1. Pin VS Code Output panel
2. Keep CodinGame output visible
3. Easy to see and copy new token on restart

### Multiple Workspaces

Each VS Code workspace has its own `.codingame/matches/` folder - data is workspace-specific.

### View Raw Match Data

Open `.codingame/matches/*.json` files in VS Code to see full match details including stdout/stderr.

### Export Statistics

Use `CodinGame: Export Statistics to CSV` in VS Code to analyze data in Excel/Sheets.

### Keyboard Shortcuts

Set up in VS Code:
- `Ctrl+Alt+S`: Sync code
- `Ctrl+Alt+M`: Show statistics

---

## 📚 Documentation

- **Full Documentation**: `docs.md`
- **Authentication Fix**: `AUTHENTICATION-FIX.md`
- **Implementation Plan**: `specs/implementation-plan-bdd.md`
- **VS Code Spec**: `specs/vscode-extension-spec.md`

---

## 🆘 Getting Help

### Log Files

**VS Code:**
- Output panel → "CodinGame" channel
- Look for `[BRIDGE]`, `[SYNC]`, `[MATCH]` tags

**Chrome:**
1. Go to `chrome://extensions/`
2. Find CodinGame extension
3. Click "Details"
4. Click "Inspect views: background page"
5. Check console for `[bridge]` logs

### Common Issues

| Issue | Quick Fix |
|-------|-----------|
| Not connecting | Update token |
| Timeout errors | Restart VS Code |
| Sync not working | Reload Chrome extension |
| No match capture | Check CodinGame page URL |

---

## 🎉 Success Indicators

You're all set when you see:

✅ Chrome popup shows "Connected"  
✅ VS Code shows "Authentication successful"  
✅ Code syncs appear in browser within 1 second  
✅ Matches are captured automatically  
✅ Statistics dashboard shows data  

---

**Happy Coding! 🚀**

For issues or questions, check the logs and documentation above.
