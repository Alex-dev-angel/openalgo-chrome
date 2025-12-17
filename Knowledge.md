# OpenAlgo Options Scalping Extension - Knowledge Base

This document details the features, user instructions, and implementation logic for the OpenAlgo Options Scalping Extension (v2.5).

## 1. Project Objective

Upgrade the existing OpenAlgo Chrome extension from a simple order placement tool to a feature-rich **Options Scalping Interface**. The new design focuses on speed, clean UI, and direct integration with OpenAlgo Python backend APIs and WebSockets for real-time data.

---

## 2. Core Features & User Instructions

### A. Dual UI Modes
**Requirement:** The extension supports two distinct interface modes, configurable via Settings.
1.  **Options Scalping Mode (Default):** The new, full-featured interface for options trading.
2.  **Quick Orders Mode (Legacy):** The original LE/LX/SE/SX button interface.
*Implementation Details:*
*   Toggle located in the Settings Panel (`⋮` button).
*   Only one mode is visible at a time to keep the UI clean.

### B. Options Scalping UI Layout
The UI is designed with a "Single Row" philosophy for the main controls to ensure compactness and speed.

#### **Row 1: Header & Information**
*   **Symbol Selector:** A dropdown menu to switch between active trading symbols (e.g., NIFTY, BANKNIFTY).
*   **Underlying LTP Display:**
    *   Shows the Last Traded Price (LTP) of the underlying asset.
    *   **Change Indicator:** Point change (+/-), and percentage change inside braces `(%)`.
    *   **Color Coding:** 
        *   **Green:** If LTP > Prev Close.
        *   **Red:** If LTP < Prev Close.
*   **Funds Display:**
    *   **Available:** Shows `availablecash`.
    *   **Today P/L:** Shows Net Profit/Loss (`m2mrealized` + `m2munrealized`). Color-coded (Green for profit, Red for loss).
*   **Theme Toggle:** Sun/Moon icon to switch between Light and Dark themes.

#### **Row 2: Trading Controls**
*   **Action Toggle (B/S):** Switches between **BUY** (Green) and **SELL** (Red).
*   **Option Type Toggle (CE/PE):** Switches between **Call (CE)** and **Put (PE)**. Shows loading animation during fetch.
*   **Strike/ATM Selector:**
    *   **Moneyness Mode:** Shows "Moneyness" (e.g., ATM, ITM1).
    *   **Strike Mode:** Shows "Strike" + Type (e.g., 26300 CE).
    *   Clicking opens the **Strike Selection Dropdown**.
*   **Lots Input:**
    *   Text input for number of lots (Always displays in Lots).
    *   Includes `+` and `-` increment/decrement buttons.
    *   **Editing:** Click to edit manually. Updates margin on blur or typing (debounced).
    *   Label "LOTS" displayed on hover.
*   **Order Type Toggle:** Cycles through: `MARKET` → `LIMIT` → `SL` → `SL-M`.
*   **Price Input:**
    *   Shows the LTP of the selected option strike.
    *   **Update Button (↻):** Inside input box to refresh price manually.
    *   Updates dynamically on blur (clicking outside).
    *   **Editable** only when Order Type is `LIMIT` or `SL`.
    *   **Disabled** (greyed out) when Order Type is `MARKET`.
*   **Order Button:**
    *   Dynamic Text: Shows precise action, price, and **Margin Required** (e.g., "BUY @ 250.50 [₹1,234]").
    *   Color changes based on Action (Green for Buy, Red for Sell).
*   **Net Position Input:**
    *   Read-only display of current open position (in Lots).
    *   **Refresh Button (↻):** Manually fetches `openposition` API.
    *   **Editing:** Click to make editable, allowing manual override of tracking quantity.
*   **Resize Button:**
    *   **Default State:** "Resize 0" (Closes the entire position).
    *   **Edit State:** If Net Position is edited, button updates to "Resize X" to adjust position to that size.

### C. Strike Selection System
**Requirement:** A slide-out/dropdown interface for selecting specific option strikes based on Expiry and Moneyness.

*   **Expiry Slider:** Horizontal scrollable list of expiry dates.
    *   **Loading:** Shows animations on UI elements when expiry is clicked.
    *   **Auto-Fetch:** Automatically loads strikes for the selected expiry.
*   **Strike Chain List:**
    *   Columns: **Moneyness** | **Strike** | **LTP**.
    *   **Range:** Shows **ITM**...**ATM**...**OTM** (configurable extension level).
    *   **Loading Animations:** Shows shimmer/loading state on columns during API calls.
    *   **Interaction:**
        *   Clicking a row selects that strike.
        *   Updates **Selected Strike** and **LTP**.
*   **Refresh Controls:**
    *   **Update:** Refreshes Strikes and LTPs.
    *   **Mode Toggle:** Switch between **Moneyness** (M) and **Strike** (S) modes.
    *   **+ More:** Extends the list to show more deep ITM/OTM strikes.

### D. Settings & Symbol Management
**Requirement:** Manage watchlists and configurations without manual JSON editing.
*   **Host URL & API Key:** Connection details for the local OpenAlgo server.
*   **WebSocket URL:** Connection URL for real-time data (e.g., `ws://127.0.0.1:8765`).
*   **UI Mode:** Toggle between Scalping and Quick Orders.
*   **Symbol Management:**
    *   **Add Symbol:** User inputs Symbol Name (e.g., NIFTY), Exchange (NSE_INDEX/NSE), and Product (MIS/NRML).
    *   **Auto-Detection:**
        *   If Exchange is `NSE_INDEX` or `NSE`, Option Exchange auto-sets to `NFO`.
        *   If Exchange is `BSE_INDEX` or `BSE`, Option Exchange auto-sets to `BFO`.
    *   **Remove Symbol:** One-click removal from the list.
*   **Persistence:** Saved to Chrome Storage (`chrome.storage.sync`).
*   **Dynamic Updates:** Settings and Symbol List apply immediately without page reload.

### E. Orders Management Dropdown
**Requirement:** Comprehensive order, trade, and position management interface accessible via the "Orders" button in the header.

#### **Tab Navigation**
*   **Orders:** Displays the orderbook with filtering and actions.
*   **Tradebook:** Displays executed trades for the day.
*   **Positions:** Displays all positions (open and closed) with P&L.

#### **Orders Tab**
*   **Filter Buttons:** Pending, Executed, Rejected, Cancelled.
*   **Order Display:** Symbol, Action tag (BUY/SELL color-coded), Price Type, Product Type, Status.
*   **Order Details:** Lots, Price, Trigger Price (if SL), LTP, Timestamp.
*   **Actions:**
    *   **Edit (✏️):** Opens inline edit mode to modify Lots, Price, Trigger Price.
    *   **Cancel (✕):** Cancels the order immediately (no confirmation).
*   **Footer:**
    *   **Refresh Button:** Manually refreshes the orderbook.
    *   **Cancel All Orders:** Cancels all open orders.

#### **Tradebook Tab**
*   **Trade Display:** Symbol, Action tag, Product Type, Timestamp.
*   **Trade Details:** Lots, Average Price, LTP, Trade Value.
*   **Footer Stats:** Total trades, Buy count, Sell count.

#### **Positions Tab**
*   **Position Display:** Symbol, Position State tag (LONG/SHORT/FLAT color-coded), Product Type.
*   **Position Details:** Lots, Average Price, LTP, P&L (with unrealized in braces).
*   **Edit Button:**
    *   Always visible for **open** positions.
    *   Appears on **hover only** for **closed (FLAT)** positions.
*   **Resize Functionality:** Click edit to enter edit mode, set target lots, and resize position via `placesmartorder` API.
*   **Footer:**
    *   **Refresh Button:** Manually refreshes positions.
    *   **Close All Positions:** Squares off all open positions.
    *   **Stats:** Open position count (Long/Short breakdown).
    *   **Total P&L:** Sum of all position P&L (color-coded green/red).

### F. Refresh Panel (Compact)
*   **Compact Design:** Right-aligned overlay.
*   **Modes:** 
    *   **Manual:** No auto-refresh.
    *   **Auto:** Interval-based refresh (default 5s).
*   **Live Data Toggle:** Button to enable/disable WebSocket connection for real-time updates.
*   **Interval Input:** Configurable refresh rate in seconds (Auto mode only).
*   **Inline Data Options:** Checkboxes for **Funds**, **Underlying**, and **Selected Strike**.

---

## 3. Order of Events & API Sequence

This section details exactly how the extension interacts with the backend APIs for different user events.

### 1. Initialization (Extension Load)
When the extension loads or injects into a page:
1.  **Load Settings:** Retrieves `hostUrl`, `apiKey`, `symbols`, `activeSymbolId`, etc.
2.  **Fetch Expiry:** `POST /api/v1/expiry` (Only on load/symbol change).
3.  **Auto-Fetch Strikes:** Automatically calls `fetchStrikeChain()` after expiry load.
4.  **WebSocket Connection:** If "Live Data" is enabled, connects to WebSocket server and authenticates.
5.  **Start Data Refresh:** 
    *   Fetches Underlying Quote and Funds once.
    *   Starts Interval Timer if "Auto" mode is active.

### 2. Symbol Selection
When a user selects a new underlying symbol:
1.  **Display Update:** UI updates immediately.
2.  **WebSocket:** Unsubscribes old symbol, subscribes to new symbol (Underlying & Strike).
3.  **API Call:** `POST /api/v1/expiry` (Fetch new expiries).
4.  **Auto-Select:** Selects nearest expiry and triggers `fetchStrikeChain()`.

### 3. Strike Chain Loading
Triggered when Expiry is selected or Symbol is changed:
1.  **Smart Fetch:**
    *   Fetches **ATM** and **ITM1** using `POST /api/v1/optionsymbol`.
    *   Calculates `Strike Interval` locally.
2.  **Local Build:** Dynamically generates the rest of the chain (ITM5...OTM5) based on interval.
3.  **LTP Fetch:** `POST /api/v1/multiquotes` for all generated symbols.
4.  **Visuals:** Loading animations on columns.

### 4. Refresh Logic (Selected Strike)
**Optimized Refresh:** Updates only the relevant data.
*   **Moneyness Mode:**
    1.  `POST /api/v1/optionsymbol` (Resolve latest strike for current offset).
    2.  `POST /api/v1/quotes` (Get LTP for that strike).
*   **Strike Mode/Update:**
    1.  `POST /api/v1/quotes` (Get LTP for selected symbol).
*   **WebSocket:** If connected, updates Underlying and Market Price (in MARKET order mode) in real-time.

### 5. Order Placement
A. **Moneyness-Based (M Mode)**
*   **API:** `POST /api/v1/optionsorder`
*   **Logic:** Backend resolves ATM strike based on spot and places order.
*   **Quantity:** Sent as total quantity (Lots * LotSize).

B. **Strike-Based (S Mode)**
*   **API:** `POST /api/v1/placeorder`
*   **Logic:** Places order for the specifically selected contract.

C. **Resize Order**
*   **API:** `POST /api/v1/placesmartorder`
*   **Logic:** Adjusts current position to match the target quantity (can close or flip position).
*   **Quantity:** Always sent as positive (absolute value of target lots).

D. **Margin Calculation**
*   **Trigger:** Price change, Lots change, Action toggle.
*   **API:** `POST /api/v1/margin`
*   **Debounce:** API calls are throttled (200ms-1s) to prevent spam.

### 6. Order Management
*   **Orderbook Fetch:** `POST /api/v1/orderbook` on dropdown open or refresh.
*   **Order Modify:** `POST /api/v1/modifyorder` with updated Lots, Price, Trigger Price.
*   **Order Cancel:** `POST /api/v1/cancelorder` with orderId and strategy.
*   **Cancel All:** `POST /api/v1/cancelallorder` for batch cancellation.

### 7. Tradebook
*   **Fetch Trades:** `POST /api/v1/tradebook` retrieves all executed trades.
*   **LTP Fetch:** `POST /api/v1/multiquotes` for real-time LTP of traded symbols.

### 8. Positions Management
*   **Fetch Positions:** `POST /api/v1/positionbook` retrieves all positions.
*   **Position Resize:** `POST /api/v1/placesmartorder` to adjust position size.
*   **Close All Positions:** `POST /api/v1/closeposition` to square off all positions.

### 9. WebSocket Integration
*   **Connection:** `ws://<host>:<port>` (Default port 8765).
*   **Subscriptions:**
    *   **Underlying:** Always subscribed for active symbol.
    *   **Strike:** Subscribed only when Order Type is `MARKET`.
*   **Throttling:** Uses `requestAnimationFrame` to limit UI repaints.

---

## 4. Implementation Logic

### A. API Endpoints Used
1.  **Fund Fetching:** `/api/v1/funds`
2.  **Underlying Quotes:** `/api/v1/quotes`
3.  **Expiry Dates:** `/api/v1/expiry`
4.  **Option Symbols:** `/api/v1/optionsymbol`
5.  **Multi-Quotes:** `/api/v1/multiquotes`
6.  **Symbol Info (Lot Size):** `/api/v1/symbol`
7.  **Place Option Order:** `/api/v1/optionsorder`
8.  **Place Regular Order:** `/api/v1/placeorder`
9.  **Place Smart Order (Resize):** `/api/v1/placesmartorder`
10. **Margin Check:** `/api/v1/margin`
11. **Open Position:** `/api/v1/openposition`
12. **Orderbook:** `/api/v1/orderbook`
13. **Modify Order:** `/api/v1/modifyorder`
14. **Cancel Order:** `/api/v1/cancelorder`
15. **Cancel All Orders:** `/api/v1/cancelallorder`
16. **Tradebook:** `/api/v1/tradebook`
17. **Positionbook:** `/api/v1/positionbook`
18. **Close All Positions:** `/api/v1/closeposition`

### B. Event Handling Logic
*   **Debounce:** `debounceTimers` used for Margin, Quotes, Funds, and Open Position to reduce API load.
*   **Input Handling:**
    *   **Lots/Price:** Update state on input, validate on blur.
    *   **Net Position:** Click enables editing for manual override.
*   **Theme Engine:** CSS classes `oa-light-theme` / `oa-dark-theme` controlled by `state.theme`.
*   **Timestamp Parsing:** Helper function `extractTimeFromTimestamp()` supports multiple broker formats:
    *   `HH:MM:SS DD-MM-YYYY` (Flattrade)
    *   `DD-Mon-YYYY HH:MM:SS` (AngelOne)
    *   `YYYY-MM-DD HH:MM:SS` (Standard)

### C. Lot Size Caching
*   **Purpose:** Avoid redundant `/api/v1/symbol` calls for lot size.
*   **Cache Key:** `underlying:expiry` for options, `symbol:exchange` for others.
*   **Batch Fetch:** `fetchLotSizesForOrders()` fetches lot sizes for all unique combinations in parallel.
*   **Sync Access:** `getCachedLotSizeForOrder()` retrieves from cache during render.

### D. Architecture
*   **Manifest V3:** Updated to `manifest_version: 3`.
*   **Storage:** Persisted via `chrome.storage.sync`.
*   **Content Script:** Injects floating UI overlay (`#openalgo-controls`).
*   **WebSocket:** Native `WebSocket` API with auto-reconnect logic.
*   **Optimizations:**
    *   **Smart Strike Switch:** Swaps CE/PE offsets locally without full API re-fetch if interval is known.
    *   **Lazy Loading:** Settings and Refresh panels built only when opened.
    *   **LTP Batch Fetch:** Uses `/api/v1/multiquotes` to fetch LTPs for all orders/trades in single call.
