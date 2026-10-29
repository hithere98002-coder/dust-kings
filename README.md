# Dust Kings

2D trophy-truck desert racing with deep tuning, a fab shop, a course editor and online races.

**Play:** https://dust-kings.onrender.com

Online: click **Online**, create a room, and send friends the 4-letter code. The free server sleeps after 15 minutes with nobody on it; the first visit after that takes about a minute to wake it up.

## Updating the game
1. Upload the new `Dust Kings v2.html` here (same name, so it replaces the old one) and commit.
2. In the Render dashboard, open the **dust-kings** service and click **Manual Deploy → Deploy latest commit**.

`server.js` serves the game page and relays race positions between players (plain Node, no packages).
