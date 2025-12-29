// OpenAlgo Options Scalping Extension v2.4
// Global state
let state = {
  action: 'BUY',
  optionType: 'CE',
  selectedExpiry: '',
  selectedOffset: 'ATM',
  selectedStrike: 0,
  selectedSymbol: '', // Full option symbol for API calls
  strikeMode: 'moneyness', // 'moneyness' or 'strike'
  extendLevel: 5, // Current ITM/OTM level (5 = ITM5/OTM5)
  useMoneyness: true,
  lots: 0, // Start with 0 until lot size is known
  orderType: 'MARKET',
  price: 0,
  lotSize: 0, // Start with 0 until determined
  underlyingLtp: 0,
  underlyingPrevClose: 0,
  optionLtp: 0,
  optionPrevClose: 0,
  margin: 0, // Required margin for current order
  theme: 'dark',
  refreshMode: 'auto',
  refreshIntervalSec: 5,
  refreshAreas: { funds: true, underlying: true, selectedStrike: true },
  loading: { funds: false, underlying: false, strikes: false, margin: false },
  fetchOpenPosAfterMargin: false,
  currentNetQty: 0, // actual net position quantity (in qty units)
  // WebSocket state
  liveDataEnabled: false,
  wsUrl: 'ws://127.0.0.1:8765',
  // Orders state
  orders: [],
  ordersFilter: 'open', // 'open', 'completed', 'rejected', 'all'
  ordersLoading: false,
  // Tradebook state
  trades: [],
  tradesLoading: false,
  // Positions state
  positions: [],
  positionsLoading: false,
  positionsFilter: 'open', // 'open' or 'closed'
  // Active tab in orders dropdown
  activeBookTab: 'orders', // 'orders', 'tradebook', 'positions'
  // SL (Stop Loss) panel state
  slOrders: [], // Filtered SL/SL-M orders for current position
  slPanelOpen: false // Track SL panel visibility
};

let isInitialized = false;

let expiryList = [];
let strikeChain = [];
let settings = {};

// WebSocket connection
let ws = null;
let wsSubscriptions = { underlying: null, strike: null };
let wsReconnectTimer = null;
let refreshInterval = null;

// Lot size cache - keyed by "underlying:expiry" (e.g., "NIFTY:26DEC24")
// For equity symbols without expiry, key is just "symbol:exchange"
const lotSizeCache = {};

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
if (document.readyState === 'interactive' || document.readyState === 'complete') init();

async function init() {
  // Prevent multiple initializations
  if (isInitialized || document.getElementById('openalgo-controls')) return;

  isInitialized = true;
  settings = await loadSettings();
  injectStyles();
  injectUI();
  applyTheme(state.theme);
  updateModeIndicator(); // Update mode indicator on init
  if (settings.uiMode === 'scalping' && settings.symbols?.length > 0 && settings.apiKey && settings.hostUrl) {
    // Add loading animation to strike button during initial loading
    const strikeBtn = document.getElementById('oa-strike-btn');
    strikeBtn?.classList.add('oa-loading');

    state.fetchOpenPosAfterMargin = true; // Enable netposition fetch after first margin call during init
    await fetchExpiry(); // Fetch expiry on initial load
    startDataRefresh();

    // Remove loading animation after initial data loading
    strikeBtn?.classList.remove('oa-loading');

    // Auto-connect WebSocket if live data is enabled
    if (state.liveDataEnabled && state.wsUrl) {
      wsConnect();
      // Wait for connection before subscribing
      setTimeout(() => updateWsSubscriptions(), 1500);
    }
  }
}

// Load settings from chrome storage
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['hostUrl', 'apiKey', 'symbols', 'activeSymbolId', 'uiMode', 'symbol', 'exchange', 'product', 'quantity', 'theme', 'refreshMode', 'refreshIntervalSec', 'refreshAreas', 'strikeMode', 'wsUrl', 'liveDataEnabled'], (data) => {
      state.theme = data.theme || 'dark';
      state.refreshMode = data.refreshMode || 'auto';
      state.refreshIntervalSec = data.refreshIntervalSec || 5;
      state.refreshAreas = data.refreshAreas || { funds: true, underlying: true, selectedStrike: true };
      state.strikeMode = data.strikeMode || 'moneyness';
      state.useMoneyness = state.strikeMode === 'moneyness';
      state.wsUrl = data.wsUrl || 'ws://127.0.0.1:8765';
      state.liveDataEnabled = data.liveDataEnabled || false;

      // Default symbols if none exist
      let symbols = data.symbols || [];
      if (symbols.length === 0) {
        symbols = [{
          id: 'default-nifty',
          symbol: 'NIFTY',
          exchange: 'NSE_INDEX',
          optionExchange: 'NFO',
          productType: 'MIS'
        }];
      }

      resolve({
        hostUrl: data.hostUrl || 'http://127.0.0.1:5000',
        apiKey: data.apiKey || '',
        symbols: symbols,
        activeSymbolId: data.activeSymbolId || symbols[0]?.id || '',
        uiMode: data.uiMode || 'scalping',
        symbol: data.symbol || '',
        exchange: data.exchange || 'NSE',
        product: data.product || 'MIS',
        quantity: data.quantity || '1'
      });
    });
  });
}

// Save settings
function saveSettings(newSettings) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(newSettings, () => {
      Object.assign(settings, newSettings);
      resolve();
    });
  });
}

// Get active symbol config
function getActiveSymbol() {
  if (!settings.symbols?.length) return null;
  return settings.symbols.find(s => s.id === settings.activeSymbolId) || settings.symbols[0];
}

// Generate UUID
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Derive option exchange from underlying exchange
function deriveOptionExchange(exchange) {
  if (exchange === 'NSE_INDEX' || exchange === 'NSE') return 'NFO';
  if (exchange === 'BSE_INDEX' || exchange === 'BSE') return 'BFO';
  return 'NFO';
}

// Quantity helpers - Lots mode only
function getQuantityMode() {
  return 'lots'; // Always lots mode
}

function toLots(quantity) {
  if (!state.lotSize) return 0;
  if (!quantity) return 0;
  const sign = quantity >= 0 ? 1 : -1;
  const lots = Math.floor(Math.abs(quantity) / state.lotSize);
  return sign * lots;
}

function toQuantity(displayValue) {
  const normalized = Math.max(1, parseInt(displayValue, 10) || 1);
  // Always lots mode: display value is lots, convert to quantity
  return state.lotSize ? normalized * state.lotSize : normalized;
}

function getDisplayQuantity(quantity = state.lots) {
  if (!quantity) return 0;
  // Always display in lots
  return toLots(quantity);
}

function getApiQuantity() {
  return Math.max(1, state.lots || 1);
}

function syncQuantityInput() {
  const lotsInput = document.getElementById('oa-lots');
  if (!lotsInput) return;
  // Keep loading state until lot size and a valid quantity are known
  if (!state.lotSize || !state.lots) return;
  const displayValue = getDisplayQuantity();
  lotsInput.value = displayValue ? displayValue.toString() : '0';
  lotsInput.classList.remove('loading');
  if (document.body.classList.contains('oa-light-theme')) {
    lotsInput.style.background = '#f0f0f0';
    lotsInput.style.color = '#222';
  }
}

function setQuantityFromDisplay(displayValue) {
  state.lots = toQuantity(displayValue);
  syncQuantityInput();
}

// Format number with commas
function formatNumber(num, decimals = 2) {
  return Number(num).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Calculate change display
function getChangeDisplay(ltp, prevClose) {
  const change = ltp - prevClose;
  const changePercent = prevClose ? ((change / prevClose) * 100) : 0;
  const arrow = change >= 0 ? '↑' : '↓';
  const sign = change >= 0 ? '+' : '';
  const colorClass = change >= 0 ? 'positive' : 'negative';
  return { change, changePercent, arrow, sign, colorClass };
}

// Extract time from various timestamp formats
// Supports: "HH:MM:SS DD-MM-YYYY" (Flattrade), "DD-Mon-YYYY HH:MM:SS" (AngelOne), "YYYY-MM-DD HH:MM:SS" (standard)
function extractTimeFromTimestamp(timestamp) {
  if (!timestamp) return '';

  // Try to match time pattern HH:MM:SS anywhere in the string
  const timeMatch = timestamp.match(/(\d{1,2}:\d{2}:\d{2})/);
  if (timeMatch) {
    return timeMatch[1];
  }

  return '';
}

// API call helper
async function apiCall(endpoint, data) {
  try {
    const response = await fetch(`${settings.hostUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: settings.apiKey, ...data })
    });
    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    return { status: 'error', message: error.message };
  }
}

// Debounce utility - delays execution and cancels previous pending calls
const debounceTimers = {};
function debounce(fn, delay, key) {
  return function (...args) {
    clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Create debounced versions of data-fetching functions
const debouncedFetchMargin = debounce(() => _fetchMargin(), 200, 'margin');
const debouncedFetchUnderlyingQuote = debounce(() => _fetchUnderlyingQuote(), 300, 'underlying');
const debouncedFetchFunds = debounce(() => _fetchFunds(), 300, 'funds');
const debouncedFetchOpenPosition = debounce(() => _fetchOpenPosition(), 200, 'openpos');
const debouncedFetchStrikeLTPs = debounce(() => _fetchStrikeLTPs(), 200, 'strikeltps');

// ============ WebSocket Functions ============

// Connect to WebSocket server
function wsConnect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (!state.wsUrl || !settings.apiKey) {
    console.log('WebSocket: Missing URL or API key');
    return;
  }

  try {
    ws = new WebSocket(state.wsUrl);

    ws.onopen = () => {
      console.log('WebSocket: Connected');
      // Authenticate
      ws.send(JSON.stringify({ action: 'authenticate', api_key: settings.apiKey }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleWsMessage(data);
      } catch (e) {
        console.error('WebSocket: Parse error', e);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket: Disconnected');
      ws = null;
      // Auto-reconnect if still enabled
      if (state.liveDataEnabled) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(() => wsConnect(), 5000);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket: Error', error);
    };
  } catch (e) {
    console.error('WebSocket: Connection failed', e);
  }
}

// Disconnect from WebSocket server
function wsDisconnect() {
  clearTimeout(wsReconnectTimer);
  if (ws) {
    ws.close();
    ws = null;
  }
  wsSubscriptions = { underlying: null, strike: null };
}

// Subscribe to a symbol for LTP updates
function wsSubscribe(symbol, exchange, type) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const key = type === 'underlying' ? 'underlying' : 'strike';

  // If already subscribed to the same symbol, do nothing
  if (wsSubscriptions[key] && wsSubscriptions[key].symbol === symbol) {
    return;
  }

  // Unsubscribe from previous if different
  if (wsSubscriptions[key] && wsSubscriptions[key].symbol !== symbol) {
    wsUnsubscribe(wsSubscriptions[key].symbol, wsSubscriptions[key].exchange, type);
  }

  ws.send(JSON.stringify({
    action: 'subscribe',
    symbol: symbol,
    exchange: exchange,
    mode: 1 // LTP mode
  }));

  wsSubscriptions[key] = { symbol, exchange };
}

// Unsubscribe from a symbol
function wsUnsubscribe(symbol, exchange, type) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    action: 'unsubscribe',
    symbol: symbol,
    exchange: exchange,
    mode: 1
  }));

  const key = type === 'underlying' ? 'underlying' : 'strike';
  wsSubscriptions[key] = null;
}

// Pending WebSocket updates - use requestAnimationFrame to throttle UI updates
let pendingWsUpdate = { underlying: null, strike: null };
let wsRafScheduled = false;

// Handle WebSocket messages
function handleWsMessage(data) {
  // Handle market data
  if (data.type === 'market_data' && data.data) {
    const symbol = getActiveSymbol();
    if (!symbol) return;

    // Check if this is underlying update
    if (wsSubscriptions.underlying &&
      data.data.symbol === wsSubscriptions.underlying.symbol) {
      pendingWsUpdate.underlying = data.data.ltp;
    }

    // Check if this is strike update (only in MARKET mode)
    if (state.orderType === 'MARKET' &&
      wsSubscriptions.strike &&
      data.data.symbol === wsSubscriptions.strike.symbol) {
      pendingWsUpdate.strike = data.data.ltp;
    }

    // Schedule update via requestAnimationFrame to avoid overloading
    if (!wsRafScheduled) {
      wsRafScheduled = true;
      requestAnimationFrame(() => {
        applyPendingWsUpdates();
        wsRafScheduled = false;
      });
    }
  }
}

// Apply pending WebSocket updates to UI
function applyPendingWsUpdates() {
  // Update underlying
  if (pendingWsUpdate.underlying !== null) {
    state.underlyingLtp = pendingWsUpdate.underlying;
    updateUnderlyingDisplay();
    pendingWsUpdate.underlying = null;
  }

  // Update strike price (MARKET mode only)
  if (pendingWsUpdate.strike !== null && state.orderType === 'MARKET') {
    state.optionLtp = pendingWsUpdate.strike;
    const priceEl = document.getElementById('oa-price');
    if (priceEl) {
      priceEl.value = state.optionLtp.toFixed(2);
      updateOrderButton();
    }
    pendingWsUpdate.strike = null;
  }
}

// Update WebSocket subscriptions based on current state
function updateWsSubscriptions() {
  if (!state.liveDataEnabled || !ws || ws.readyState !== WebSocket.OPEN) return;

  const symbol = getActiveSymbol();
  if (!symbol) return;

  // Subscribe to underlying
  wsSubscribe(symbol.symbol, symbol.exchange, 'underlying');

  // Subscribe to strike only in MARKET mode
  if (state.orderType === 'MARKET' && state.selectedSymbol) {
    const selected = strikeChain.find(s => s.offset === state.selectedOffset);
    if (selected) {
      wsSubscribe(selected.symbol, selected.exchange, 'strike');
    }
  } else if (wsSubscriptions.strike) {
    // Unsubscribe from strike if not in MARKET mode
    wsUnsubscribe(wsSubscriptions.strike.symbol, wsSubscriptions.strike.exchange, 'strike');
  }
}

// Toggle live data
function toggleLiveData(enable) {
  state.liveDataEnabled = enable;
  saveSettings({ liveDataEnabled: enable });

  if (enable) {
    wsConnect();
    // Wait for connection before subscribing
    setTimeout(() => updateWsSubscriptions(), 1000);
  } else {
    wsDisconnect();
  }
}

// Fetch margin for current order - internal implementation
async function _fetchMargin() {
  const symbol = getActiveSymbol();
  if (!symbol || !state.selectedSymbol) return;

  const price = state.orderType === 'MARKET' ? state.optionLtp : state.price;
  if (!price) return;

  const quantity = getApiQuantity();

  state.loading.margin = true;
  const result = await apiCall('/api/v1/margin', {
    positions: [{
      symbol: state.selectedSymbol,
      exchange: symbol.optionExchange,
      action: state.action,
      product: symbol.product || 'MIS',
      pricetype: state.orderType === 'SL-M' ? 'SL-M' : (state.orderType === 'SL' ? 'SL' : (state.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET')),
      quantity: String(quantity),
      price: String(price)
    }]
  });

  if (result.status === 'success' && result.data) {
    state.margin = result.data.total_margin_required || 0;
    updateOrderButton();
  }
  state.loading.margin = false;
  if (state.fetchOpenPosAfterMargin) {
    state.fetchOpenPosAfterMargin = false;
    fetchOpenPosition();
  }
}

// Public wrapper - uses debounce
function fetchMargin() {
  debouncedFetchMargin();
}

// Fetch quotes for underlying - internal implementation
async function _fetchUnderlyingQuote() {
  const symbol = getActiveSymbol();
  if (!symbol) return;
  state.loading.underlying = true;
  showLoadingIndicator('underlying');
  const result = await apiCall('/api/v1/quotes', { symbol: symbol.symbol, exchange: symbol.exchange });
  state.loading.underlying = false;
  hideLoadingIndicator('underlying');
  if (result.status === 'success' && result.data) {
    state.underlyingLtp = result.data.ltp || 0;
    state.underlyingPrevClose = result.data.prev_close || 0;
    updateUnderlyingDisplay();
  }
}

// Public wrapper - uses debounce
function fetchUnderlyingQuote() {
  debouncedFetchUnderlyingQuote();
}

// Fetch funds - internal implementation
async function _fetchFunds() {
  state.loading.funds = true;
  showLoadingIndicator('funds');
  const result = await apiCall('/api/v1/funds', {});
  state.loading.funds = false;
  hideLoadingIndicator('funds');
  if (result.status === 'success' && result.data) {
    const available = parseFloat(result.data.availablecash) || 0;
    const realized = parseFloat(result.data.m2mrealized) || 0;
    const unrealized = parseFloat(result.data.m2munrealized) || 0;
    const todayPL = realized + unrealized;
    updateFundsDisplay(available, todayPL);
  }
}

// Public wrapper - uses debounce
function fetchFunds() {
  debouncedFetchFunds();
}

// Fetch open position for current symbol - internal implementation
async function _fetchOpenPosition() {
  const symbol = getActiveSymbol();
  if (!symbol || !state.selectedSymbol) return;

  const result = await apiCall('/api/v1/openposition', {
    strategy: 'Chrome',
    symbol: state.selectedSymbol,
    exchange: symbol.optionExchange,
    product: symbol.productType
  });

  if (result.status === 'success') {
    // Convert qty to lots for display
    const quantity = parseInt(result.quantity) || 0;
    updateNetPosDisplay(quantity);

    // Reset netpos input editing state on successful API fetch
    const netposEl = document.getElementById('oa-netpos');
    if (netposEl) {
      netposEl.dataset.editing = 'false';
      netposEl.dataset.qty = quantity.toString();
      netposEl.value = toLots(quantity).toString(); // Sync display value
      updateResizeButton(); // Update button to "Resize 0"
      fetchSLOrdersForPosition(); // Update SL button state
    }
  }
}

// Public wrapper - uses debounce
function fetchOpenPosition() {
  debouncedFetchOpenPosition();
}

// Fetch expiry list
async function fetchExpiry() {
  // Don't fetch if API credentials are not configured
  if (!settings.apiKey || !settings.hostUrl) return;

  const symbol = getActiveSymbol();
  if (!symbol) return;
  const result = await apiCall('/api/v1/expiry', {
    symbol: symbol.symbol,
    exchange: symbol.optionExchange,
    instrumenttype: 'options'
  });
  if (result.status === 'success' && result.data) {
    expiryList = result.data;
    if (expiryList.length > 0 && !state.selectedExpiry) {
      state.selectedExpiry = expiryList[0].replace(/-/g, '').toUpperCase();
    }
    updateExpirySlider();
    // Auto-fetch strike chain after expiry is loaded
    if (state.selectedExpiry) {
      await fetchStrikeChain();
    }
  }
}

// Fetch strike chain using optionsymbol API - OPTIMIZED
// Only fetches ATM and ITM1, calculates strike interval, builds rest dynamically
let isFetchingStrikeChain = false;
let isExtendingStrikes = false;
let strikeInterval = 0; // Calculated from |ATM - ITM1|
let cachedATMStrike = 0; // Cache ATM strike for CE/PE switching

async function fetchStrikeChain() {
  // Prevent concurrent executions
  if (isFetchingStrikeChain) return;
  isFetchingStrikeChain = true;

  const symbol = getActiveSymbol();
  if (!symbol || !state.selectedExpiry) {
    isFetchingStrikeChain = false;
    return;
  }

  state.loading.strikes = true;
  showLoadingIndicator('strikes');

  try {
    // Only fetch ATM and ITM1 via API to calculate strike interval
    const [atmResult, itm1Result] = await Promise.all([
      apiCall('/api/v1/optionsymbol', {
        strategy: 'Chrome',
        underlying: symbol.symbol,
        exchange: symbol.exchange,
        expiry_date: state.selectedExpiry,
        offset: 'ATM',
        option_type: state.optionType
      }),
      apiCall('/api/v1/optionsymbol', {
        strategy: 'Chrome',
        underlying: symbol.symbol,
        exchange: symbol.exchange,
        expiry_date: state.selectedExpiry,
        offset: 'ITM1',
        option_type: state.optionType
      })
    ]);

    if (atmResult.status !== 'success' || itm1Result.status !== 'success') {
      console.error('Failed to fetch ATM/ITM1 strikes');
      isFetchingStrikeChain = false;
      state.loading.strikes = false;
      hideLoadingIndicator('strikes');
      return;
    }

    // Parse strikes from symbols
    const atmStrikeMatch = atmResult.symbol.match(/^[A-Z]+(?:\d{2}[A-Z]{3}\d{2})(\d+)(?=CE$|PE$)/);
    const itm1StrikeMatch = itm1Result.symbol.match(/^[A-Z]+(?:\d{2}[A-Z]{3}\d{2})(\d+)(?=CE$|PE$)/);

    const atmStrike = atmStrikeMatch ? parseInt(atmStrikeMatch[1]) : 0;
    const itm1Strike = itm1StrikeMatch ? parseInt(itm1StrikeMatch[1]) : 0;

    // Calculate strike interval (absolute difference - just the gap between strikes)
    strikeInterval = Math.abs(atmStrike - itm1Strike);
    cachedATMStrike = atmStrike;

    // Store lotsize from ATM (applies to all strikes for this underlying)
    state.lotSize = atmResult.lotsize || 25;

    // Build strike chain dynamically
    // For CE: ITM is below ATM (lower strike), OTM is above ATM (higher strike)
    // For PE: ITM is above ATM (higher strike), OTM is below ATM (lower strike)
    const isPE = state.optionType === 'PE';
    const itmDirection = isPE ? 1 : -1;  // PE: ITM is higher (+), CE: ITM is lower (-)
    const otmDirection = isPE ? -1 : 1;  // PE: OTM is lower (-), CE: OTM is higher (+)

    strikeChain = [];

    // Build ITM strikes (ITM5 to ITM1)
    for (let i = state.extendLevel; i >= 1; i--) {
      const strike = atmStrike + (i * strikeInterval * itmDirection);
      strikeChain.push({
        offset: `ITM${i}`,
        symbol: `${symbol.symbol}${state.selectedExpiry}${strike}${state.optionType}`,
        exchange: atmResult.exchange || symbol.optionExchange,
        strike: strike,
        lotsize: state.lotSize,
        ltp: 0,
        prevClose: 0
      });
    }

    // Add ATM (from API response)
    strikeChain.push({
      offset: 'ATM',
      symbol: atmResult.symbol,
      exchange: atmResult.exchange || symbol.optionExchange,
      strike: atmStrike,
      lotsize: state.lotSize,
      ltp: 0,
      prevClose: 0
    });

    // Build OTM strikes (OTM1 to OTM5)
    for (let i = 1; i <= state.extendLevel; i++) {
      const strike = atmStrike + (i * strikeInterval * otmDirection);
      strikeChain.push({
        offset: `OTM${i}`,
        symbol: `${symbol.symbol}${state.selectedExpiry}${strike}${state.optionType}`,
        exchange: atmResult.exchange || symbol.optionExchange,
        strike: strike,
        lotsize: state.lotSize,
        ltp: 0,
        prevClose: 0
      });
    }

    // Initialize quantity input now that we know the lot size
    initializeQuantityInput();

    // Fetch LTPs for all strikes
    await _fetchStrikeLTPs();
  } finally {
    isFetchingStrikeChain = false;
  }
}

// Switch CE/PE without API call - just swap offset meanings and rebuild symbols
async function switchOptionType() {
  if (!strikeInterval || !cachedATMStrike) {
    // No cached data, need full fetch
    await fetchStrikeChain();
    return;
  }

  const symbol = getActiveSymbol();
  if (!symbol) return;

  // Rebuild strike chain with swapped option type and flipped ITM/OTM
  const newChain = [];

  // When switching CE to PE (or vice versa), ITM becomes OTM and OTM becomes ITM
  // ATM stays the same
  for (const item of strikeChain) {
    let newOffset = item.offset;

    // Flip ITM <-> OTM (ATM stays same)
    if (item.offset.startsWith('ITM')) {
      const level = item.offset.replace('ITM', '');
      newOffset = `OTM${level}`;
    } else if (item.offset.startsWith('OTM')) {
      const level = item.offset.replace('OTM', '');
      newOffset = `ITM${level}`;
    }

    newChain.push({
      offset: newOffset,
      symbol: `${symbol.symbol}${state.selectedExpiry}${item.strike}${state.optionType}`,
      exchange: item.exchange,
      strike: item.strike,
      lotsize: item.lotsize,
      ltp: 0,
      prevClose: 0
    });
  }

  // Sort chain by offset (ITM5...ITM1, ATM, OTM1...OTM5)
  strikeChain = newChain.sort((a, b) => {
    const getOrder = (offset) => {
      if (offset === 'ATM') return 0;
      const level = parseInt(offset.replace(/[A-Z]/g, ''));
      return offset.startsWith('ITM') ? -level : level;
    };
    return getOrder(a.offset) - getOrder(b.offset);
  });

  // Only fetch new LTPs, no optionsymbol API call needed
  await _fetchStrikeLTPs();
}

// Fetch LTPs for strike chain - internal implementation
async function _fetchStrikeLTPs() {
  if (strikeChain.length === 0) return;
  const symbols = strikeChain.map(s => ({ symbol: s.symbol, exchange: s.exchange }));
  const result = await apiCall('/api/v1/multiquotes', { symbols });

  if (result.status === 'success' && result.results) {
    result.results.forEach(r => {
      const strike = strikeChain.find(s => s.symbol === r.symbol);
      if (strike && r.data) {
        strike.ltp = r.data.ltp || 0;
        strike.prevClose = r.data.prev_close || 0;
      }
    });
  }
  state.loading.strikes = false;
  hideLoadingIndicator('strikes');
  updateStrikeDropdown();
  updateSelectedOptionLTP();
}

// Public wrapper - uses debounce
function fetchStrikeLTPs() {
  debouncedFetchStrikeLTPs();
}

// Update selected option LTP display
function updateSelectedOptionLTP() {
  const selected = strikeChain.find(s => s.offset === state.selectedOffset);
  if (selected) {
    state.optionLtp = selected.ltp;
    state.optionPrevClose = selected.prevClose;
    state.selectedStrike = selected.strike;
    // Prepare symbol for margin call which happens in updatePriceDisplay
    state.selectedSymbol = selected.symbol;

    // Sync price for Limit orders on selection change
    state.price = state.optionLtp;

    updatePriceDisplay(true);
    updateStrikeButton();
    fetchMargin(); // Auto-fetch margin when strike changes
    updateWsSubscriptions(); // Update WebSocket subscriptions for new strike
  }
}

// Place order using optionsorder API (moneyness-based)
async function placeOptionsOrder() {
  const symbol = getActiveSymbol();
  if (!symbol) return showNotification('No symbol selected', 'error');

  const quantity = getApiQuantity();

  const data = {
    strategy: 'Chrome',
    underlying: symbol.symbol,
    exchange: symbol.exchange,
    expiry_date: state.selectedExpiry,
    offset: state.selectedOffset,
    option_type: state.optionType,
    action: state.action,
    quantity: String(quantity),
    pricetype: state.orderType,
    product: symbol.productType,
    price: state.orderType === 'LIMIT' || state.orderType === 'SL' ? String(state.price) : '0',
    trigger_price: state.orderType === 'SL' || state.orderType === 'SL-M' ? String(state.price) : '0'
  };

  const result = await apiCall('/api/v1/optionsorder', data);
  handleOrderResponse(result);
}

// Place order using placeorder API (strike-based)
async function placePlaceOrder() {
  const symbol = getActiveSymbol();
  const selected = strikeChain.find(s => s.offset === state.selectedOffset);
  if (!symbol || !selected) return showNotification('No strike selected', 'error');

  const quantity = getApiQuantity();

  const data = {
    strategy: 'Chrome',
    symbol: selected.symbol,
    exchange: selected.exchange,
    action: state.action,
    product: symbol.productType,
    pricetype: state.orderType,
    quantity: String(quantity),
    price: state.orderType === 'LIMIT' || state.orderType === 'SL' ? String(state.price) : '0',
    trigger_price: state.orderType === 'SL' || state.orderType === 'SL-M' ? String(state.price) : '0'
  };

  const result = await apiCall('/api/v1/placeorder', data);
  handleOrderResponse(result);
}

// Handle order response
function handleOrderResponse(result) {
  if (result.status === 'success') {
    showNotification(`Order placed! ID: ${result.orderid}`, 'success');
    // Refresh net position after successful order
    setTimeout(() => fetchOpenPosition(), 1000); // Small delay to allow position to update
  } else {
    showNotification(`Order failed: ${result.message}`, 'error');
  }
}

// Legacy order functions for quick mode
function placeLegacyOrder(action) {
  const url = `${settings.hostUrl}/api/v1/placeorder`;
  const data = {
    apikey: settings.apiKey,
    strategy: 'Chrome',
    symbol: settings.symbol,
    action: action,
    exchange: settings.exchange,
    pricetype: 'MARKET',
    product: settings.product,
    quantity: settings.quantity
  };
  makeLegacyApiCall(url, data, action === 'BUY' ? 'Long Entry' : 'Short Entry');
}

function placeLegacySmartOrder(action) {
  const url = `${settings.hostUrl}/api/v1/placesmartorder`;
  const data = {
    apikey: settings.apiKey,
    strategy: 'Chrome',
    exchange: settings.exchange,
    symbol: settings.symbol,
    action: action,
    product: settings.product,
    pricetype: 'MARKET',
    quantity: '0',
    position_size: '0'
  };
  makeLegacyApiCall(url, data, action === 'BUY' ? 'Long Exit' : 'Short Exit');
}

function makeLegacyApiCall(url, data, actionText) {
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    .then(r => r.json())
    .then(data => {
      if (data.status === 'success') showNotification(`${actionText} successful!`, 'success');
      else showNotification(`Error: ${data.message}`, 'error');
    })
    .catch(e => showNotification(`API Error: ${e.message}`, 'error'));
}

// Start data refresh interval (expiry only on init, not in interval)
let isInitialLoad = true;
function startDataRefresh() {
  // Don't start data refresh if API credentials are not configured
  if (!settings.apiKey || !settings.hostUrl) return;

  // On initial load, always fetch data regardless of checkbox settings
  if (isInitialLoad) {
    fetchUnderlyingQuote();
    fetchFunds();
    isInitialLoad = false;
  } else {
    // Subsequent refreshes respect checkbox settings
    if (state.refreshAreas.underlying) fetchUnderlyingQuote();
    if (state.refreshAreas.funds) fetchFunds();
  }

  // Don't fetch expiry here - only on symbol change and initial load
  if (refreshInterval) clearInterval(refreshInterval);
  if (state.refreshMode === 'auto') {
    refreshInterval = setInterval(() => {
      if (state.refreshAreas.underlying) fetchUnderlyingQuote();
      if (state.refreshAreas.funds) fetchFunds();
      if (state.refreshAreas.selectedStrike) refreshSelectedStrike();
    }, state.refreshIntervalSec * 1000);
  }
}

// Manual refresh
function manualRefresh() {
  if (state.refreshAreas.underlying) fetchUnderlyingQuote();
  if (state.refreshAreas.funds) fetchFunds();
  if (state.refreshAreas.selectedStrike) refreshSelectedStrike();
}

// Refresh only the selected strike's LTP and update price if MARKET
// In moneyness mode: first get latest strike from optionsymbol API, then quotes
async function refreshSelectedStrike() {
  const symbol = getActiveSymbol();
  if (!symbol) return;

  state.loading.strikes = true;
  showLoadingIndicator('strikes');

  // In moneyness mode, get latest strike from optionsymbol API first
  if (state.strikeMode === 'moneyness' && state.selectedExpiry) {
    const symbolResult = await apiCall('/api/v1/optionsymbol', {
      strategy: 'Chrome',
      underlying: symbol.symbol,
      exchange: symbol.exchange,
      expiry_date: state.selectedExpiry,
      offset: state.selectedOffset,
      option_type: state.optionType
    });

    if (symbolResult.status === 'success') {
      const strikeMatch = symbolResult.symbol.match(/^[A-Z]+(?:\d{2}[A-Z]{3}\d{2})(\d+)(?=CE$|PE$)/);
      const newStrike = strikeMatch ? parseInt(strikeMatch[1]) : 0;

      // If strike changed for the selected offset (e.g. ATM shifted), or lot size changed
      if ((newStrike !== state.selectedStrike && state.selectedStrike !== 0) || (symbolResult.lotsize && symbolResult.lotsize !== state.lotSize)) {
        // Rebuild the whole chain to ensure consistency and avoid duplicates
        fetchStrikeChain();
        return;
      }

      state.selectedStrike = newStrike;
      state.selectedSymbol = symbolResult.symbol;
      state.lotSize = symbolResult.lotsize || state.lotSize;

      // Update strike in chain
      const chainItem = strikeChain.find(s => s.offset === state.selectedOffset);
      if (chainItem) {
        chainItem.symbol = symbolResult.symbol;
        chainItem.strike = state.selectedStrike;
      }
    }
  }

  // Now fetch quote for the selected strike
  const selected = strikeChain.find(s => s.offset === state.selectedOffset);
  if (selected) {
    const result = await apiCall('/api/v1/quotes', { symbol: selected.symbol, exchange: selected.exchange });
    if (result.status === 'success' && result.data) {
      selected.ltp = result.data.ltp || 0;
      selected.prevClose = result.data.prev_close || 0;
      state.optionLtp = selected.ltp;
      state.optionPrevClose = selected.prevClose;
      // Ensure available for margin call
      state.selectedSymbol = selected.symbol;

      // Update price display unconditionally (updates UI and fetches margin)
      updatePriceDisplay();
      updateStrikeDropdown();
      updateStrikeButton();
    }
  }

  state.loading.strikes = false;
  hideLoadingIndicator('strikes');
}

// Show notification
function showNotification(message, type, duration = 1000) {
  const n = document.createElement('div');
  n.className = `openalgo-notification ${type}`;
  n.textContent = message;
  document.body.appendChild(n);
  setTimeout(() => { n.classList.add('fadeOut'); setTimeout(() => n.remove(), 500); }, duration);
}

// UI update functions
function updateUnderlyingDisplay() {
  const el = document.getElementById('oa-underlying-ltp');
  if (!el) return;
  const { change, changePercent, sign, colorClass } = getChangeDisplay(state.underlyingLtp, state.underlyingPrevClose);
  el.innerHTML = `<span class="oa-ltp-value ${colorClass}">${formatNumber(state.underlyingLtp)}</span> <span class="oa-change-text">${sign}${formatNumber(change)} (${sign}${changePercent.toFixed(2)}%)</span>`;
}

function updateFundsDisplay(available, todayPL) {
  const el = document.getElementById('oa-funds');
  if (!el) return;
  const plClass = todayPL >= 0 ? 'positive' : 'negative';
  const plSign = todayPL >= 0 ? '+' : '';
  el.innerHTML = `Avail: ₹${formatNumber(available, 0)} | <span class="${plClass}">P/L: ${plSign}₹${formatNumber(todayPL, 0)}</span>`;
}

function updateNetPosDisplay(quantity) {
  const el = document.getElementById('oa-netpos');
  if (el) {
    state.currentNetQty = quantity;
    // Always display in lots
    const displayValue = toLots(quantity);
    el.dataset.qty = quantity.toString();
    el.value = displayValue.toString();
    updateResizeButton();
    updateSLButton(); // Update SL button state
  }
}

function updateNetPosDisplayMode() {
  const el = document.getElementById('oa-netpos');
  if (el) {
    // Only update if not editing (though API fetch usually resets editing state)
    if (el.dataset.editing === 'true') return;

    const baseQty = parseInt(el.dataset.qty || el.value) || 0;
    // Always display in lots
    const displayValue = toLots(baseQty);
    el.value = displayValue.toString();
    updateResizeButton();
  }
}

function updateModeIndicator() {
  const el = document.getElementById('oa-mode-indicator');
  if (el) {
    el.textContent = 'LOTS';
    // Show lot size in tooltip when hovering
    const lotSizeText = state.lotSize ? `1 LOT = ${state.lotSize} Qty` : 'Loading...';
    el.title = lotSizeText;
    el.style.background = 'rgba(92, 107, 192, 0.1)';
    el.style.color = '#5c6bc0';
    el.style.cursor = 'default'; // No click needed
  }
  syncQuantityInput();
  updateResizeButton();
}

function getTargetNetQty() {
  const el = document.getElementById('oa-netpos');
  if (!el) return 0;
  // dataset.qty stores base quantity (qty units)
  const datasetQty = parseInt(el.dataset.qty || '0', 10);
  if (datasetQty) return datasetQty;
  const displayValue = parseInt(el.value || '0', 10) || 0;
  // Always lots mode: display value is lots, convert to qty
  return displayValue * (state.lotSize || 1);
}

function updateResizeButton() {
  const btn = document.getElementById('oa-resize-btn');
  const netposEl = document.getElementById('oa-netpos');
  if (!btn || !netposEl) return;

  const isEditing = netposEl.dataset.editing === 'true';

  if (!isEditing) {
    // Default state: Resize 0 (Close position)
    btn.className = 'oa-resize-btn neutral';
    btn.textContent = 'Resize 0';
    btn.title = 'Close position';
  } else {
    // Editing state: Resize to target
    const target = getTargetNetQty();
    const displayQty = toLots(target);
    btn.className = 'oa-resize-btn';
    btn.textContent = `Resize ${displayQty}`;
    btn.title = `Resize position to ${displayQty} lots`;
  }
}

// ============ SL (Stop Loss) Functions ============

function updateSLButton() {
  const btn = document.getElementById('oa-sl-btn');
  if (!btn) return;

  const netposEl = document.getElementById('oa-netpos');
  const currentQty = netposEl ? parseInt(netposEl.dataset.qty || '0') : 0;

  if (currentQty === 0) {
    // No open position - disable SL button and close panel if open
    btn.disabled = true;
    btn.className = 'oa-sl-btn neutral';
    btn.title = 'No open position';
    // Auto-close SL panel when button becomes disabled
    toggleSLPanel(false);
  } else {
    // Has open position - enable SL button
    btn.disabled = false;
    btn.className = 'oa-sl-btn' + (state.slOrders.length > 0 ? ' has-orders' : '');
    btn.title = `Manage SL (${state.slOrders.length} orders)`;
  }
}

async function fetchSLOrdersForPosition() {
  if (!settings.apiKey || !state.selectedSymbol) {
    state.slOrders = [];
    return;
  }

  const netposEl = document.getElementById('oa-netpos');
  const currentQty = netposEl ? parseInt(netposEl.dataset.qty || '0') : 0;

  if (currentQty === 0) {
    state.slOrders = [];
    updateSLButton();
    return;
  }

  // Determine the opposite action for SL orders
  // For LONG position (qty > 0), SL orders should be SELL
  // For SHORT position (qty < 0), SL orders should be BUY
  const slAction = currentQty > 0 ? 'SELL' : 'BUY';

  const result = await apiCall('/api/v1/orderbook', {});

  if (result.status === 'success' && result.data && result.data.orders) {
    // Filter for SL/SL-M orders matching the current symbol and opposite action
    state.slOrders = result.data.orders.filter(o => {
      const status = (o.order_status || '').toLowerCase();
      const isPending = ['open', 'trigger pending', 'validation pending', 'put order req received'].includes(status);
      const isSL = ['SL', 'SL-M'].includes(o.pricetype);
      const matchesSymbol = o.symbol === state.selectedSymbol;
      const matchesAction = o.action === slAction;

      return isPending && isSL && matchesSymbol && matchesAction;
    });

    // Fetch lot sizes for SL orders
    if (state.slOrders.length > 0) {
      await fetchLotSizesForOrders(state.slOrders);
    }
  } else {
    state.slOrders = [];
  }

  updateSLButton();
}

function toggleSLPanel(show) {
  const panel = document.getElementById('oa-sl-panel');
  if (!panel) return;

  const isShow = show !== undefined ? show : panel.classList.contains('hidden');

  if (isShow) {
    // Close other panels first
    toggleStrikeDropdown(false);
    toggleOrdersDropdown(false);
    const settingsPanel = document.getElementById('oa-settings-panel');
    if (settingsPanel) settingsPanel.classList.add('hidden');
    const refreshPanel = document.getElementById('oa-refresh-panel');
    if (refreshPanel) refreshPanel.classList.add('hidden');

    // Fetch latest SL orders and render
    fetchSLOrdersForPosition().then(() => {
      renderSLPanel();
      panel.classList.remove('hidden');
    });
  } else {
    panel.classList.add('hidden');
  }

  state.slPanelOpen = isShow;
}

function renderSLPanel() {
  const list = document.getElementById('oa-sl-list');
  const posInfoEl = document.getElementById('oa-sl-position-info');
  const remainingInput = document.getElementById('oa-sl-remaining-lots');

  if (!list) return;

  const netposEl = document.getElementById('oa-netpos');
  const currentQty = netposEl ? parseInt(netposEl.dataset.qty || '0') : 0;
  const currentLots = toLots(Math.abs(currentQty));
  const positionType = currentQty > 0 ? 'LONG' : currentQty < 0 ? 'SHORT' : 'FLAT';

  // Update position info
  if (posInfoEl) {
    posInfoEl.textContent = `${positionType} ${currentLots} lots`;
  }

  // Calculate covered lots
  let coveredLots = 0;
  state.slOrders.forEach(o => {
    const orderLotSize = getCachedLotSizeForOrder(o);
    const qty = parseInt(o.quantity) || 0;
    coveredLots += orderLotSize > 0 ? Math.floor(qty / orderLotSize) : qty;
  });

  // Calculate remaining lots with sign based on position direction
  const absRemainingLots = Math.max(0, currentLots - coveredLots);
  // For SHORT position (currentQty < 0), show negative sign
  const signedRemainingLots = currentQty < 0 ? -absRemainingLots : absRemainingLots;
  if (remainingInput) {
    remainingInput.value = signedRemainingLots;
  }

  // Render SL orders
  if (state.slOrders.length === 0) {
    list.innerHTML = '<div class="oa-empty-state">No pending SL orders</div>';
    return;
  }

  list.innerHTML = state.slOrders.map(o => {
    const orderLotSize = getCachedLotSizeForOrder(o);
    const qty = parseInt(o.quantity) || 0;
    const displayLots = orderLotSize > 0 ? Math.floor(qty / orderLotSize) : qty;
    const isBuy = o.action === 'BUY';
    const actionClass = isBuy ? 'buy' : 'sell';

    return `
      <div class="oa-sl-order-item" data-orderid="${o.orderid}" data-strategy="${o.strategy || 'Chrome'}">
        <input type="checkbox" class="oa-sl-checkbox" data-orderid="${o.orderid}">
        <div class="oa-sl-order-info">
          <div><span class="oa-sl-action-tag ${actionClass}">${o.action}</span>${o.pricetype} ${displayLots} lots</div>
          <div class="oa-sl-order-details">Trg: ${o.trigger_price || 0} | Price: ${o.price}</div>
        </div>
        <div class="oa-order-actions">
          <button class="oa-order-action-btn edit" data-orderid="${o.orderid}" title="Edit">✏️</button>
        </div>
      </div>
    `;
  }).join('');

  // Add edit listeners
  list.querySelectorAll('.oa-order-action-btn.edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const orderId = btn.dataset.orderid;
      enterSLEditMode(orderId);
    });
  });
}

function enterSLEditMode(orderId) {
  const item = document.querySelector(`.oa-sl-order-item[data-orderid="${orderId}"]`);
  if (!item) return;

  const order = state.slOrders.find(o => o.orderid === orderId);
  if (!order) return;

  const orderLotSize = getCachedLotSizeForOrder(order);
  const qty = parseInt(order.quantity) || 0;
  const displayLots = orderLotSize > 0 ? Math.floor(qty / orderLotSize) : qty;

  item.innerHTML = `
    <div style="width:100%;padding:4px 0;">
      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <div style="width:55px;">
          <label style="font-size:8px;color:#888;display:block;margin-bottom:2px;">Lots</label>
          <input type="number" id="sl-edit-lots-${orderId}" value="${displayLots}" class="oa-small-input" style="width:100%;padding:6px;">
        </div>
        <div style="width:75px;">
          <label style="font-size:8px;color:#888;display:block;margin-bottom:2px;">Trigger</label>
          <input type="number" id="sl-edit-trg-${orderId}" value="${order.trigger_price || 0}" step="0.1" class="oa-small-input" style="width:100%;padding:6px;">
        </div>
        <div style="width:75px;">
          <label style="font-size:8px;color:#888;display:block;margin-bottom:2px;">Price</label>
          <input type="number" id="sl-edit-price-${orderId}" value="${order.price}" step="0.1" class="oa-small-input" style="width:100%;padding:6px;">
        </div>
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button class="oa-btn success" id="sl-save-${orderId}" style="padding:4px 12px;font-size:9px;">Save</button>
        <button class="oa-btn" id="sl-cancel-${orderId}" style="padding:4px 12px;font-size:9px;background:#333;color:#ccc;">Cancel</button>
      </div>
    </div>
  `;

  document.getElementById(`sl-save-${orderId}`)?.addEventListener('click', () => saveSLOrder(orderId));
  document.getElementById(`sl-cancel-${orderId}`)?.addEventListener('click', () => renderSLPanel());
}

async function saveSLOrder(orderId) {
  const order = state.slOrders.find(o => o.orderid === orderId);
  if (!order) return;

  const lotsInput = document.getElementById(`sl-edit-lots-${orderId}`);
  const trgInput = document.getElementById(`sl-edit-trg-${orderId}`);
  const priceInput = document.getElementById(`sl-edit-price-${orderId}`);

  const orderLotSize = getCachedLotSizeForOrder(order);
  const lotsValue = lotsInput ? parseInt(lotsInput.value) || 1 : 1;
  const newQty = lotsValue * orderLotSize;
  const newTrg = trgInput ? trgInput.value : (order.trigger_price || 0);
  const newPrice = priceInput ? priceInput.value : order.price;

  const btn = document.getElementById(`sl-save-${orderId}`);
  if (btn) { btn.textContent = '...'; btn.disabled = true; }

  const data = {
    strategy: order.strategy || 'Chrome',
    symbol: order.symbol,
    exchange: order.exchange,
    action: order.action,
    product: order.product,
    pricetype: order.pricetype,
    orderid: order.orderid,
    quantity: String(newQty),
    price: String(newPrice),
    trigger_price: String(newTrg),
    disclosed_quantity: "0"
  };

  const result = await apiCall('/api/v1/modifyorder', data);

  if (result.status === 'success') {
    showNotification(`SL order modified`, 'success');
    fetchSLOrdersForPosition().then(() => renderSLPanel());
  } else {
    showNotification(`Modify failed: ${result.message || 'Unknown'}`, 'error');
    if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
  }
}

async function exitAtMarket() {
  // Get selected orders or all orders
  const checkboxes = document.querySelectorAll('.oa-sl-checkbox:checked');
  const orderIds = checkboxes.length > 0
    ? Array.from(checkboxes).map(cb => cb.dataset.orderid)
    : state.slOrders.map(o => o.orderid);

  if (orderIds.length === 0) {
    showNotification('No SL orders to execute', 'info');
    return;
  }

  const btn = document.getElementById('oa-sl-exit-market');
  if (btn) { btn.textContent = 'Executing...'; btn.disabled = true; }

  let successCount = 0;
  for (const orderId of orderIds) {
    const order = state.slOrders.find(o => o.orderid === orderId);
    if (!order) continue;

    // Modify order to MARKET type for immediate execution
    const result = await apiCall('/api/v1/modifyorder', {
      strategy: order.strategy || 'Chrome',
      symbol: order.symbol,
      exchange: order.exchange,
      action: order.action,
      product: order.product,
      pricetype: 'MARKET',
      orderid: order.orderid,
      quantity: String(order.quantity),
      price: '0',
      trigger_price: '0',
      disclosed_quantity: '0'
    });

    if (result.status === 'success') successCount++;
  }

  showNotification(`${successCount}/${orderIds.length} orders executed at market`,
    successCount > 0 ? 'success' : 'error');

  if (btn) { btn.textContent = 'Exit at Market'; btn.disabled = false; }

  // Refresh SL orders and position
  fetchSLOrdersForPosition().then(() => renderSLPanel());
  fetchOpenPosition();
}

async function cancelAllSLOrders() {
  // Get selected orders or all orders
  const checkboxes = document.querySelectorAll('.oa-sl-checkbox:checked');
  const orderIds = checkboxes.length > 0
    ? Array.from(checkboxes).map(cb => cb.dataset.orderid)
    : state.slOrders.map(o => o.orderid);

  if (orderIds.length === 0) {
    showNotification('No SL orders to cancel', 'info');
    return;
  }

  const btn = document.getElementById('oa-sl-cancel-all');
  if (btn) { btn.textContent = 'Cancelling...'; btn.disabled = true; }

  let successCount = 0;
  for (const orderId of orderIds) {
    const order = state.slOrders.find(o => o.orderid === orderId);
    const result = await apiCall('/api/v1/cancelorder', {
      strategy: order?.strategy || 'Chrome',
      orderid: orderId
    });

    if (result.status === 'success') successCount++;
  }

  showNotification(`${successCount}/${orderIds.length} SL orders cancelled`,
    successCount > 0 ? 'success' : 'error');

  if (btn) { btn.textContent = 'Cancel All'; btn.disabled = false; }

  // Refresh SL orders
  fetchSLOrdersForPosition().then(() => {
    renderSLPanel();
    updateSLButton();
  });
}

async function addSLOrder() {
  const symbol = getActiveSymbol();
  if (!symbol || !state.selectedSymbol) {
    showNotification('No symbol selected', 'error');
    return;
  }

  const netposEl = document.getElementById('oa-netpos');
  const currentQty = netposEl ? parseInt(netposEl.dataset.qty || '0') : 0;

  if (currentQty === 0) {
    showNotification('No open position', 'error');
    return;
  }

  // Get lots from the uncovered input (user can edit it, use absolute value)
  const lotsInput = document.getElementById('oa-sl-remaining-lots');
  const lots = lotsInput ? Math.abs(parseInt(lotsInput.value) || 0) : 0;

  if (lots <= 0) {
    showNotification('Enter lots quantity', 'error');
    return;
  }

  // Determine action: opposite of position
  const slAction = currentQty > 0 ? 'SELL' : 'BUY';
  const actionClass = slAction === 'BUY' ? 'buy' : 'sell';

  // Use current option LTP as both trigger price and limit price
  const triggerPrice = state.optionLtp || 0;
  const limitPrice = state.optionLtp || 0;

  // Show edit form in the SL list (prepend a new order item)
  const list = document.getElementById('oa-sl-list');
  if (!list) return;

  // Create a new order form at the top of the list
  const newOrderId = 'new-sl-' + Date.now();
  const newOrderHtml = `
    <div class="oa-sl-order-item oa-sl-new-order" data-orderid="${newOrderId}">
      <div style="width:100%;padding:4px 0;">
        <div style="margin-bottom:6px;">
          <span class="oa-sl-action-tag ${actionClass}">${slAction}</span>
          <span style="font-size:10px;color:#ff6b35;font-weight:600;">New SL Order</span>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <div style="width:55px;">
            <label style="font-size:8px;color:#888;display:block;margin-bottom:2px;">Lots</label>
            <input type="number" id="sl-new-lots-${newOrderId}" value="${lots}" class="oa-small-input" style="width:100%;padding:6px;">
          </div>
          <div style="width:75px;">
            <label style="font-size:8px;color:#888;display:block;margin-bottom:2px;">Trigger</label>
            <input type="number" id="sl-new-trg-${newOrderId}" value="${triggerPrice}" step="0.1" class="oa-small-input" style="width:100%;padding:6px;">
          </div>
          <div style="width:75px;">
            <label style="font-size:8px;color:#888;display:block;margin-bottom:2px;">Price</label>
            <input type="number" id="sl-new-price-${newOrderId}" value="${limitPrice}" step="0.1" class="oa-small-input" style="width:100%;padding:6px;">
          </div>
        </div>
        <div style="display:flex;gap:6px;justify-content:flex-end;">
          <button class="oa-btn success" id="sl-place-${newOrderId}" style="padding:4px 12px;font-size:9px;">Place SL</button>
          <button class="oa-btn" id="sl-cancel-new-${newOrderId}" style="padding:4px 12px;font-size:9px;background:#333;color:#ccc;">Cancel</button>
        </div>
      </div>
    </div>
  `;

  // Insert at the top of the list
  list.insertAdjacentHTML('afterbegin', newOrderHtml);

  // Add event listeners
  document.getElementById(`sl-place-${newOrderId}`)?.addEventListener('click', () => placeNewSLOrder(newOrderId, slAction));
  document.getElementById(`sl-cancel-new-${newOrderId}`)?.addEventListener('click', () => {
    const newItem = document.querySelector(`.oa-sl-new-order[data-orderid="${newOrderId}"]`);
    if (newItem) newItem.remove();
  });
}

async function placeNewSLOrder(newOrderId, slAction) {
  const symbol = getActiveSymbol();
  if (!symbol || !state.selectedSymbol) {
    showNotification('No symbol selected', 'error');
    return;
  }

  const lotsInput = document.getElementById(`sl-new-lots-${newOrderId}`);
  const trgInput = document.getElementById(`sl-new-trg-${newOrderId}`);
  const priceInput = document.getElementById(`sl-new-price-${newOrderId}`);

  const lots = lotsInput ? Math.abs(parseInt(lotsInput.value) || 0) : 0;
  const triggerPrice = trgInput ? parseFloat(trgInput.value) || 0 : 0;
  const limitPrice = priceInput ? parseFloat(priceInput.value) || 0 : 0;

  if (lots <= 0) {
    showNotification('Enter lots quantity', 'error');
    return;
  }

  if (triggerPrice <= 0) {
    showNotification('Enter trigger price', 'error');
    return;
  }

  const quantity = lots * (state.lotSize || 1);

  const btn = document.getElementById(`sl-place-${newOrderId}`);
  if (btn) { btn.textContent = 'Placing...'; btn.disabled = true; }

  const result = await apiCall('/api/v1/placeorder', {
    strategy: 'Chrome',
    symbol: state.selectedSymbol,
    exchange: symbol.optionExchange,
    action: slAction,
    product: symbol.productType,
    pricetype: 'SL',
    quantity: String(quantity),
    price: String(limitPrice),
    trigger_price: String(triggerPrice),
    disclosed_quantity: '0'
  });

  if (result.status === 'success') {
    showNotification(`SL order placed! ID: ${result.orderid || ''}`, 'success');
    // Refresh SL orders
    fetchSLOrdersForPosition().then(() => renderSLPanel());
  } else {
    showNotification(`SL order failed: ${result.message || 'Unknown'}`, 'error');
    if (btn) { btn.textContent = 'Place SL'; btn.disabled = false; }
  }
}

async function placeResize() {
  const symbol = getActiveSymbol();
  if (!symbol || !state.selectedSymbol) return showNotification('No symbol selected', 'error');

  const netposEl = document.getElementById('oa-netpos');
  const isEditing = netposEl && netposEl.dataset.editing === 'true';

  // If not editing, target is ALWAYS 0 (Close Position)
  const targetQty = isEditing ? getTargetNetQty() : 0;

  const data = {
    strategy: 'Chrome',
    symbol: state.selectedSymbol,
    exchange: symbol.optionExchange,
    action: state.action,
    product: symbol.productType,
    pricetype: 'MARKET',
    quantity: String(Math.abs(targetQty)), // Quantity must be positive
    position_size: String(targetQty), // Use target position
    price: '0',
    trigger_price: '0'
  };

  const result = await apiCall('/api/v1/placesmartorder', data);
  if (result.status === 'success') {
    // Show orderid if present, otherwise show message field
    const msg = result.orderid
      ? `Resize placed! ID: ${result.orderid}`
      : (result.message || 'Resize placed');
    showNotification(msg, 'success');
    fetchOpenPosition();
  } else {
    showNotification(`Resize failed: ${result.message || 'Unknown error'}`, 'error');
  }
}

function initializeQuantityInput() {
  const lotsInput = document.getElementById('oa-lots');
  const lotsDecBtn = document.getElementById('oa-lots-dec');
  const lotsIncBtn = document.getElementById('oa-lots-inc');
  const lotsUpdateBtn = document.getElementById('oa-lots-update');

  if (lotsInput && state.lotSize > 0) {
    // Set initial quantity to 1 * lot size
    state.lots = state.lotSize;
    lotsInput.disabled = false;
    lotsInput.readOnly = true; // Keep readonly like netpos
    lotsInput.classList.remove('loading');
    syncQuantityInput();

    // Enable buttons
    if (lotsDecBtn) lotsDecBtn.disabled = false;
    if (lotsIncBtn) lotsIncBtn.disabled = false;
    if (lotsUpdateBtn) lotsUpdateBtn.disabled = false;

    // Update mode indicator to show lot size
    updateModeIndicator();
    // Margin fetch removed to avoid duplicate calls during chain load
    updateResizeButton();
  }
}

// Simplified validation - always valid in lots mode
function validateQuantity() {
  syncQuantityInput();
  return true;
}

// Simplified netpos validation - always valid in lots mode
function validateNetposQuantity() {
  const netposEl = document.getElementById('oa-netpos');
  if (!netposEl) return true;

  const displayValue = parseInt(netposEl.value || '0', 10) || 0;
  const qty = displayValue * (state.lotSize || 1);
  netposEl.dataset.qty = qty.toString();
  return true;
}

function updateExpirySlider() {
  const container = document.getElementById('oa-expiry-slider');
  if (!container) return;
  container.innerHTML = expiryList.slice(0, 8).map(exp => {
    const formatted = exp.replace(/-/g, '').toUpperCase();
    const short = exp.split('-').slice(0, 2).join('');
    const isActive = formatted === state.selectedExpiry;
    return `<button class="oa-expiry-btn ${isActive ? 'active' : ''}" data-expiry="${formatted}">${short}</button>`;
  }).join('');
  container.querySelectorAll('.oa-expiry-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.selectedExpiry = btn.dataset.expiry;
      updateExpirySlider();

      // Show loading on multiple elements
      const strikeBtn = document.getElementById('oa-strike-btn');
      const priceInput = document.getElementById('oa-price');
      const orderBtn = document.getElementById('oa-order-btn');
      const strikeCol = document.getElementById('oa-strike-col');
      const ltpCol = document.getElementById('oa-ltp-col');

      strikeBtn?.classList.add('oa-loading');
      priceInput?.classList.add('oa-loading');
      orderBtn?.classList.add('oa-loading');
      strikeCol?.classList.add('oa-loading');

      await fetchStrikeChain();

      // Now loading on LTP column while quotes fetch
      strikeCol?.classList.remove('oa-loading');
      ltpCol?.classList.add('oa-loading');

      // fetchStrikeChain already calls _fetchStrikeLTPs, so no need to call it again here
      // This prevents the "multiquotes called twice" issue

      // Remove all loading
      strikeBtn?.classList.remove('oa-loading');
      priceInput?.classList.remove('oa-loading');
      orderBtn?.classList.remove('oa-loading');
      ltpCol?.classList.remove('oa-loading');

      // Update open position for the new expiry context
      fetchOpenPosition();
    });
  });
}

function updateStrikeDropdown() {
  const list = document.getElementById('oa-strike-list');
  if (!list) return;
  const optType = state.optionType;
  const isStrikeMode = state.strikeMode === 'strike';

  list.innerHTML = strikeChain.map(s => {
    const { colorClass } = getChangeDisplay(s.ltp, s.prevClose);
    const isATM = s.offset === 'ATM';
    const isSelected = s.offset === state.selectedOffset;

    // In moneyness mode: highlight offset, strike non-editable
    // In strike mode: offset dim, strike editable
    const offsetClass = isStrikeMode ? 'oa-moneyness dim' : 'oa-moneyness';
    const strikeClass = isStrikeMode ? 'oa-strike editable' : 'oa-strike';

    return `<div class="oa-strike-row ${isATM ? 'atm' : ''} ${isSelected ? 'selected' : ''}" data-offset="${s.offset}" data-strike="${s.strike}" data-symbol="${s.symbol}">
      <span class="${offsetClass}">${s.offset}</span>
      <span class="${strikeClass}">${s.strike} <span class="oa-opt-badge ${optType === 'CE' ? 'ce' : 'pe'}">${optType}</span></span>
      <span class="oa-ltp ${colorClass}">${formatNumber(s.ltp)}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.oa-strike-row').forEach(row => {
    row.addEventListener('click', () => {
      state.selectedOffset = row.dataset.offset;
      state.selectedStrike = parseInt(row.dataset.strike);
      state.selectedSymbol = row.dataset.symbol; // Save full symbol for API calls
      updateSelectedOptionLTP();
      updateStrikeButton();
      toggleStrikeDropdown(false);
      toggleSLPanel(false); // Close SL panel when strike changes
      // Immediately update dropdown HTML so it shows correct selection when opened again
      updateStrikeDropdown();
      // Fetch net position for the selected strike
      fetchOpenPosition();
    });
  });
}

function updateStrikeButton() {
  const btn = document.getElementById('oa-strike-btn');
  if (!btn) return;
  if (state.strikeMode === 'moneyness') {
    // Show only moneyness (ATM, ITM1, etc.) in moneyness mode
    btn.textContent = state.selectedOffset;
  } else {
    btn.textContent = `${state.selectedStrike} ${state.optionType}`;
  }
}

function updatePriceDisplay(forceUpdate = false) {
  const el = document.getElementById('oa-price');
  if (!el) return;

  if (state.orderType === 'MARKET' || forceUpdate) {
    el.value = state.optionLtp.toFixed(2);
    state.price = state.optionLtp; // Sync state.price to prevent stale values
  }

  if (state.orderType === 'MARKET') {
    el.disabled = true;
    updateOrderButton();
    // In MARKET mode, don't auto-fetch margin - user clicks refresh button
  } else {
    el.disabled = false;
    updateOrderButton();
  }
}

function updateOrderButton() {
  const btn = document.getElementById('oa-order-btn');
  if (!btn) return;
  const marginText = state.margin > 0 ? ` [₹${formatNumber(state.margin, 0)}]` : '';
  const displayQty = getDisplayQuantity();
  const qtyText = `${displayQty} lot`;

  if (state.orderType === 'MARKET') {
    btn.textContent = `${qtyText} @ MARKET${marginText}`;
  } else {
    const price = state.price;
    btn.textContent = `${qtyText} @ ${formatNumber(price)}${marginText}`;
  }
  btn.className = `oa-order-btn ${state.action === 'BUY' ? 'buy' : 'sell'}`;
}

function toggleStrikeDropdown(show) {
  const dd = document.getElementById('oa-strike-dropdown');
  if (dd) dd.classList.toggle('hidden', !show);

  // Update hover text based on current mode
  const updateBtn = document.getElementById('oa-update-strikes');
  if (updateBtn) {
    updateBtn.title = state.strikeMode === 'moneyness'
      ? 'Update Strikes and LTP'
      : 'Update LTP';
  }
}

// Inject the main UI
function injectUI() {
  const container = document.createElement('div');
  container.id = 'openalgo-controls';
  container.className = settings.uiMode === 'scalping' ? 'oa-container oa-scalping' : 'oa-container oa-quick';

  if (settings.uiMode === 'scalping') {
    container.innerHTML = buildScalpingUI();
    setupScalpingEvents(container);
  } else {
    container.innerHTML = buildQuickUI();
    setupQuickEvents(container);
  }

  makeDraggable(container);
  document.body.appendChild(container);
}

function buildScalpingUI() {
  const symbol = getActiveSymbol();
  const themeIcon = state.theme === 'dark' ? '☀️' : '🌙';
  const modeLabel = state.strikeMode === 'moneyness' ? 'M' : 'S';
  // Initial strike button text based on mode
  const strikeText = state.strikeMode === 'moneyness' ? 'Moneyness' : 'Strike';
  return `
    <div class="oa-drag-handle"></div>
    <div class="oa-header">
      <select id="oa-symbol-select" class="oa-select">
        ${settings.symbols.map(s => `<option value="${s.id}" ${s.id === settings.activeSymbolId ? 'selected' : ''}>${s.symbol}</option>`).join('')}
        ${settings.symbols.length === 0 ? '<option value="">Add symbol in settings</option>' : ''}
      </select>
      <span id="oa-underlying-ltp" class="oa-ltp-display">--</span>
      <span id="oa-mode-indicator" class="oa-mode-indicator">--</span>
      <span id="oa-funds" class="oa-funds">--</span>
      <button id="oa-orders-btn" class="oa-header-btn" title="Orders">Orders</button>
      <button id="oa-theme-btn" class="oa-icon-btn" title="Toggle theme">${themeIcon}</button>
      <button id="oa-refresh-btn" class="oa-icon-btn" title="Refresh settings">🔄</button>
      <button id="oa-settings-btn" class="oa-icon-btn">⋮</button>
    </div>
    <div class="oa-controls">
      <button id="oa-action-btn" class="oa-toggle buy">B</button>
      <button id="oa-option-type-btn" class="oa-toggle">CE</button>
      <button id="oa-strike-btn" class="oa-strike-select">${strikeText}</button>
      <div class="oa-lots">
        <button id="oa-lots-dec" class="oa-lot-btn" disabled>−</button>
        <input id="oa-lots" type="text" value="0" readonly>
        <button id="oa-lots-inc" class="oa-lot-btn" disabled>+</button>
      </div>
      <button id="oa-ordertype-btn" class="oa-toggle oa-ordertype-fixed">${state.orderType}</button>
      <div class="oa-input-wrapper price-wrapper">
        <input id="oa-price" type="text" class="oa-price-input" value="0">
        <button id="oa-price-update" class="oa-input-update" title="Set">↻</button>
      </div>
      <button id="oa-order-btn" class="oa-order-btn buy">BUY @ --</button>
      <div class="oa-netpos-input-wrapper">
        <span class="oa-netpos-label" title="Net Position">P</span>
        <input id="oa-netpos" type="text" class="oa-netpos-input" value="0" readonly>
        <button id="oa-netpos-update" class="oa-input-update" title="Refresh position">↻</button>
      </div>
      <button id="oa-resize-btn" class="oa-resize-btn neutral" title="Resize position">Resize</button>
      <button id="oa-sl-btn" class="oa-sl-btn neutral" disabled title="Manage Stop Loss">SL</button>
    </div>
    <div id="oa-strike-dropdown" class="oa-strike-dropdown hidden">
      <div class="oa-expiry-container">
        <button id="oa-expiry-left" class="oa-expiry-arrow">‹</button>
        <div id="oa-expiry-slider" class="oa-expiry-slider"></div>
        <button id="oa-expiry-right" class="oa-expiry-arrow">›</button>
      </div>
      <div class="oa-strike-header"><span>Moneyness</span><span id="oa-strike-col">Strike</span><span id="oa-ltp-col">LTP</span></div>
      <div id="oa-strike-list" class="oa-strike-list"></div>
      <div class="oa-strike-actions">
        <button id="oa-update-strikes" class="oa-action-btn" title="Update strikes & quotes">⟳ Update</button>
        <button id="oa-mode-toggle" class="oa-action-btn" title="Toggle Moneyness/Strike mode">${modeLabel}</button>
        <button id="oa-extend-strikes" class="oa-action-btn" title="Load more strikes">+ More</button>
      </div>
    </div>
    <div id="oa-orders-dropdown" class="oa-orders-dropdown hidden">
      <div class="oa-orders-header">
        <div class="oa-tab-menu">
          <button class="oa-tab-btn active" data-tab="orders">Orders</button>
          <button class="oa-tab-btn" data-tab="tradebook">Tradebook</button>
          <button class="oa-tab-btn" data-tab="positions">Positions</button>
        </div>
      </div>
      <!-- Orders Tab -->
      <div id="oa-tab-orders" class="oa-tab-content">
        <div class="oa-orders-filters">
          <button class="oa-filter-btn" data-filter="open">Pending</button>
          <button class="oa-filter-btn" data-filter="completed">Executed</button>
          <button class="oa-filter-btn" data-filter="rejected">Rejected</button>
          <button class="oa-filter-btn" data-filter="cancelled">Cancelled</button>
        </div>
        <div id="oa-orders-list" class="oa-orders-list"></div>
        <div class="oa-orders-footer">
          <button id="oa-refresh-orders" class="oa-footer-btn refresh">↻ Refresh</button>
          <button id="oa-cancel-all-btn" class="oa-footer-btn">Cancel All Orders</button>
        </div>
      </div>
      <!-- Tradebook Tab -->
      <div id="oa-tab-tradebook" class="oa-tab-content hidden">
        <div id="oa-tradebook-list" class="oa-orders-list"></div>
        <div class="oa-orders-footer" id="oa-tradebook-footer">
          <button id="oa-refresh-tradebook" class="oa-footer-btn refresh">↻ Refresh</button>
          <span id="oa-tradebook-stats" class="oa-footer-stats"></span>
        </div>
      </div>
      <!-- Positions Tab -->
      <div id="oa-tab-positions" class="oa-tab-content hidden">
        <div class="oa-orders-filters">
          <button class="oa-filter-btn active" data-filter="open" id="oa-pos-filter-open">Open</button>
          <button class="oa-filter-btn" data-filter="closed" id="oa-pos-filter-closed">Closed</button>
        </div>
        <div id="oa-positions-list" class="oa-orders-list"></div>
        <div class="oa-orders-footer" id="oa-positions-footer">
          <button id="oa-refresh-positions" class="oa-footer-btn refresh">↻ Refresh</button>
          <button id="oa-close-all-btn" class="oa-footer-btn">Close All Positions</button>
          <span id="oa-positions-stats" class="oa-footer-stats"></span>
          <span id="oa-positions-pnl" class="oa-footer-pnl"></span>
        </div>
      </div>
    </div>
    <div id="oa-sl-panel" class="oa-sl-panel hidden">
      <div class="oa-sl-header">
        <span>Stop Loss Orders</span>
        <span id="oa-sl-position-info" class="oa-sl-position-info">--</span>
      </div>
      <div id="oa-sl-list" class="oa-orders-list"></div>
      <div class="oa-sl-footer">
        <div class="oa-sl-footer-row">
          <div class="oa-sl-remaining">
            <button id="oa-sl-refresh" class="oa-sl-refresh-btn" title="Refresh position and SL orders">↻</button>
            <span>Uncovered:</span>
            <input id="oa-sl-remaining-lots" type="text" class="oa-sl-input" value="0">
            <span>lots</span>
            <button id="oa-sl-add-btn" class="oa-sl-add-btn" title="Add SL Order">+ Add SL</button>
          </div>
          <div class="oa-sl-actions">
            <button id="oa-sl-exit-market" class="oa-footer-btn danger small">Exit Mkt</button>
            <button id="oa-sl-cancel-all" class="oa-footer-btn small">Cancel All</button>
          </div>
        </div>
      </div>
    </div>
    <div id="oa-refresh-panel" class="oa-refresh-panel hidden"></div>
    <div id="oa-settings-panel" class="oa-settings-panel hidden"></div>
  `;
}

function buildQuickUI() {
  return `
    <div class="oa-drag-handle"></div>
    <div class="oa-quick-row">
      <button id="le-btn" class="oa-btn success">LE</button>
      <button id="lx-btn" class="oa-btn warning">LX</button>
      <button id="se-btn" class="oa-btn error">SE</button>
      <button id="sx-btn" class="oa-btn info">SX</button>
      <button id="oa-settings-btn" class="oa-icon-btn">⋮</button>
    </div>
    <div id="oa-settings-panel" class="oa-settings-panel hidden"></div>
  `;
}

function setupScalpingEvents(container) {
  // Symbol select - only fetch expiry when symbol changes
  container.querySelector('#oa-symbol-select')?.addEventListener('change', async (e) => {
    // Add loading animation to strike button during symbol change
    const strikeBtn = document.getElementById('oa-strike-btn');
    strikeBtn?.classList.add('oa-loading');

    await saveSettings({ activeSymbolId: e.target.value });

    // Unsubscribe from old WebSocket subscriptions before changing symbol
    if (wsSubscriptions.underlying) {
      wsUnsubscribe(wsSubscriptions.underlying.symbol, wsSubscriptions.underlying.exchange, 'underlying');
    }
    if (wsSubscriptions.strike) {
      wsUnsubscribe(wsSubscriptions.strike.symbol, wsSubscriptions.strike.exchange, 'strike');
    }

    strikeChain = [];
    state.selectedExpiry = '';
    state.selectedSymbol = ''; // Clear symbol to prevent stale margin calls
    state.extendLevel = 5;
    state.fetchOpenPosAfterMargin = true;
    updateModeIndicator(); // Update mode indicator for new symbol
    validateQuantity(); // Validate quantity for new symbol
    if (settings.apiKey && settings.hostUrl) {
      await fetchExpiry(); // Only fetch expiry on symbol change
      startDataRefresh();
      // Update WebSocket subscriptions for new symbol
      updateWsSubscriptions();
    }

    // Remove loading animation after all data is loaded
    strikeBtn?.classList.remove('oa-loading');
  });

  // Mode indicator - no click handler needed, just shows lot size on hover

  // Action toggle (B/S)
  container.querySelector('#oa-action-btn')?.addEventListener('click', (e) => {
    state.action = state.action === 'BUY' ? 'SELL' : 'BUY';
    e.target.textContent = state.action === 'BUY' ? 'B' : 'S';
    e.target.className = `oa-toggle ${state.action === 'BUY' ? 'buy' : 'sell'}`;
    updateOrderButton();
    fetchMargin();
  });

  // Option type toggle (CE/PE) - optimized: use switchOptionType to avoid API calls
  container.querySelector('#oa-option-type-btn')?.addEventListener('click', async (e) => {
    state.optionType = state.optionType === 'CE' ? 'PE' : 'CE';
    e.target.textContent = state.optionType;
    e.target.dataset.label = e.target.textContent;
    e.target.classList.add('oa-loading');
    // Use optimized switch that doesn't call optionsymbol API
    await switchOptionType();
    e.target.classList.remove('oa-loading');
    // Update price element with new strike LTP (for all order types)
    updatePriceDisplay();
    // Fetch openposition for the new option symbol
    fetchOpenPosition();
  });

  // Strike button
  container.querySelector('#oa-strike-btn')?.addEventListener('click', () => {
    const dd = document.getElementById('oa-strike-dropdown');
    const isHidden = dd.classList.contains('hidden');
    toggleStrikeDropdown(isHidden);
    if (isHidden && strikeChain.length === 0) fetchStrikeChain();
  });

  // Lots controls
  container.querySelector('#oa-lots-dec')?.addEventListener('click', () => {
    const symbol = getActiveSymbol();
    const lotsInput = document.getElementById('oa-lots');

    // Don't process if controls are disabled or in loading state
    if (!symbol || !lotsInput || lotsInput.classList.contains('oa-loading')) return;

    const step = state.lotSize || 1;
    const minQuantity = state.lotSize || 1;

    if (state.lots > minQuantity) {
      state.lots = Math.max(minQuantity, state.lots - step);
      syncQuantityInput();
      state.quantityAutoCorrected = false; // Reset flag on manual change
      const validationPassed = validateQuantity();
      if (validationPassed) {
        fetchMargin();
      }
    }
  });
  container.querySelector('#oa-lots-inc')?.addEventListener('click', () => {
    const symbol = getActiveSymbol();
    const lotsInput = document.getElementById('oa-lots');

    // Don't process if controls are disabled or in loading state
    if (!symbol || !lotsInput || lotsInput.classList.contains('oa-loading')) return;

    const step = state.lotSize || 1;
    state.lots += step;
    syncQuantityInput();
    state.quantityAutoCorrected = false; // Reset flag on manual change
    const validationPassed = validateQuantity();
    if (validationPassed) {
      fetchMargin();
    }
    updateResizeButton();
  });
  // Qty input - handle click to enable editing (like netpos)
  container.querySelector('#oa-lots')?.addEventListener('click', (e) => {
    if (e.target.readOnly && !e.target.classList.contains('oa-loading')) {
      e.target.readOnly = false;
      e.target.classList.add('editable');
      e.target.select();
    }
  });

  // Qty input - debounced margin calculation while typing (1 sec)
  let lotsDebounceTimer = null;
  container.querySelector('#oa-lots')?.addEventListener('input', (e) => {
    if (e.target.readOnly) return;
    const symbol = getActiveSymbol();
    const minDisplay = symbol ? (symbol.quantityMode === 'lots' ? 1 : (state.lotSize || 1)) : 1;
    const parsedValue = parseInt(e.target.value) || minDisplay;
    setQuantityFromDisplay(parsedValue);
    updateResizeButton();

    // Fast UI update (100ms)
    clearTimeout(state.lotsUiDebounceTimer);
    state.lotsUiDebounceTimer = setTimeout(() => {
      updateOrderButton();
    }, 100);

    // Debounce margin calculation by 1 second
    clearTimeout(lotsDebounceTimer);
    lotsDebounceTimer = setTimeout(() => {
      fetchMargin();
    }, 1000);
  });

  // Qty input - handle blur (click outside)
  container.querySelector('#oa-lots')?.addEventListener('blur', (e) => {
    if (!e.target.readOnly) {
      clearTimeout(lotsDebounceTimer);
      e.target.readOnly = true;
      e.target.classList.remove('editable');
      fetchMargin(); // Fetch margin immediately on blur
    }
  });

  container.querySelector('#oa-lots')?.addEventListener('change', (e) => {
    // Don't process changes if input is in loading state
    if (e.target.classList.contains('oa-loading')) return;

    const symbol = getActiveSymbol();

    // Reset auto-corrected flag when user manually changes quantity
    state.quantityAutoCorrected = false;

    // Set the quantity first, then validate
    const minDisplay = symbol ? (symbol.quantityMode === 'lots' ? 1 : (state.lotSize || 1)) : 1;
    const parsedValue = parseInt(e.target.value) || minDisplay;
    setQuantityFromDisplay(parsedValue);

    // Validate quantity in quantity mode
    let validationPassed = true;
    if (symbol && symbol.quantityMode === 'quantity') {
      validationPassed = validateQuantity();
    }

    // Re-apply minimum constraints after validation (in case validation changed the value)
    if (state.lots < minDisplay) {
      state.lots = minDisplay;
      syncQuantityInput();
    }

    if (validationPassed) {
      fetchMargin();
    }
    updateResizeButton();
  });

  // Order type toggle
  const orderTypes = ['MARKET', 'LIMIT', 'SL', 'SL-M'];
  container.querySelector('#oa-ordertype-btn')?.addEventListener('click', (e) => {
    const idx = orderTypes.indexOf(state.orderType);
    state.orderType = orderTypes[(idx + 1) % orderTypes.length];
    e.target.textContent = state.orderType;
    updatePriceDisplay(true);
    fetchMargin(); // Auto-fetch margin when order type changes
    updateWsSubscriptions(); // Update WebSocket subscriptions based on new mode
  });

  // Price input - debounced margin calculation while typing (1 sec)
  const priceInput = container.querySelector('#oa-price');
  let priceDebounceTimer = null;
  priceInput?.addEventListener('input', (e) => {
    if (state.orderType === 'MARKET') return; // MARKET mode doesn't allow editing
    state.price = parseFloat(e.target.value) || 0;
    updateOrderButton();
    // Debounce margin calculation by 1 second
    clearTimeout(priceDebounceTimer);
    priceDebounceTimer = setTimeout(() => {
      fetchMargin();
    }, 1000);
  });
  priceInput?.addEventListener('blur', (e) => {
    if (state.orderType === 'MARKET') return;
    clearTimeout(priceDebounceTimer);
    state.price = parseFloat(e.target.value) || 0;
    updateOrderButton();
    fetchMargin();
  });

  // Price update button (↻) - Fetch latest price via API and calculate margin
  const priceUpdateBtn = container.querySelector('#oa-price-update');
  if (priceUpdateBtn) priceUpdateBtn.title = 'Refresh price';
  priceUpdateBtn?.addEventListener('click', async () => {
    const priceEl = document.getElementById('oa-price');
    if (!priceEl) return;

    // Call quotes API to get latest price
    const selected = strikeChain.find(s => s.offset === state.selectedOffset);
    if (selected) {
      const result = await apiCall('/api/v1/quotes', { symbol: selected.symbol, exchange: selected.exchange });
      if (result.status === 'success' && result.data) {
        state.optionLtp = result.data.ltp || state.optionLtp;
        state.optionPrevClose = result.data.prev_close || state.optionPrevClose;
        selected.ltp = state.optionLtp;
        selected.prevClose = state.optionPrevClose;
      }
    }

    // Update display price and calculate margin
    priceEl.value = state.optionLtp.toFixed(2);
    state.price = state.optionLtp;
    updateOrderButton();

    // Clear any pending debounce timer to prevent double call
    if (priceDebounceTimer) {
      clearTimeout(priceDebounceTimer);
      priceDebounceTimer = null;
    }

    fetchMargin();
  });



  // Net pos refresh functionality - double click on input to refresh
  container.querySelector('#oa-netpos')?.addEventListener('dblclick', () => {
    if (!document.getElementById('oa-netpos').classList.contains('editable')) {
      fetchOpenPosition();
    }
  });

  // Net pos input - make editable on click
  container.querySelector('#oa-netpos')?.addEventListener('click', (e) => {
    if (e.target.readOnly && !e.target.classList.contains('oa-loading')) {
      e.target.readOnly = false;
      e.target.classList.add('editable');
      e.target.select();
      e.target.dataset.editing = 'true';
    }
  });

  // Net pos input - handle blur (click outside)
  container.querySelector('#oa-netpos')?.addEventListener('blur', (e) => {
    if (!e.target.readOnly) {
      e.target.readOnly = true;
      e.target.classList.remove('editable');
      // Keep editing flag true so update button can still commit the value
      e.target.dataset.editing = e.target.dataset.editing || 'true';
      // Validate netpos quantity
      validateNetposQuantity();
    }
  });

  // Net pos input - handle change
  container.querySelector('#oa-netpos')?.addEventListener('change', (e) => {
    // Don't process changes if input is in loading state
    if (e.target.value === 'Loading...' || e.target.readOnly) return;
    validateNetposQuantity();
    updateResizeButton();
  });

  // Net pos input - auto-update resize button while typing (100ms debounce)
  let netposDebounceTimer = null;
  container.querySelector('#oa-netpos')?.addEventListener('input', (e) => {
    if (e.target.readOnly) return;
    clearTimeout(netposDebounceTimer);
    netposDebounceTimer = setTimeout(() => {
      // Update dataset.qty for resize button calculation
      const displayValue = parseInt(e.target.value) || 0;
      const qty = displayValue * (state.lotSize || 1);
      e.target.dataset.qty = qty.toString();
      updateResizeButton();
    }, 100);
  });

  // Net pos refresh button (↻) - always fetch openposition when clicked
  container.querySelector('#oa-netpos-update')?.addEventListener('click', () => {
    const netposEl = document.getElementById('oa-netpos');
    const updateBtn = document.getElementById('oa-netpos-update');

    // If in edit mode, exit edit mode first
    if (netposEl && !netposEl.readOnly) {
      netposEl.readOnly = true;
      netposEl.classList.remove('editable');
      netposEl.dataset.editing = 'false';
      // Keep title as 'Refresh position'
      if (updateBtn) updateBtn.title = 'Refresh position';
    }

    // Always fetch current position from API
    fetchOpenPosition();
  });

  // Resize button
  container.querySelector('#oa-resize-btn')?.addEventListener('click', () => {
    // Check if netpos quantity is valid, if not reset to valid qty with warning and return
    const isValid = validateNetposQuantity();
    if (!isValid) {
      // Quantity was auto-corrected, warning shown, don't place order
      return;
    }
    // Quantity is valid, place resize
    placeResize();
  });

  // SL button
  container.querySelector('#oa-sl-btn')?.addEventListener('click', () => {
    toggleSLPanel();
  });

  // SL Exit at Market
  container.querySelector('#oa-sl-exit-market')?.addEventListener('click', () => {
    exitAtMarket();
  });

  // SL Cancel All
  container.querySelector('#oa-sl-cancel-all')?.addEventListener('click', () => {
    cancelAllSLOrders();
  });

  // SL Add Order
  container.querySelector('#oa-sl-add-btn')?.addEventListener('click', () => {
    addSLOrder();
  });

  // SL Panel Refresh
  container.querySelector('#oa-sl-refresh')?.addEventListener('click', async () => {
    const btn = document.getElementById('oa-sl-refresh');
    if (btn) btn.classList.add('spinning');

    // Fetch position and SL orders
    await _fetchOpenPosition();
    // Note: _fetchOpenPosition already calls fetchSLOrdersForPosition
    renderSLPanel();

    if (btn) btn.classList.remove('spinning');
  });

  // Order button
  container.querySelector('#oa-order-btn')?.addEventListener('click', () => {
    // Validate quantity before placing order
    const symbol = getActiveSymbol();
    let validationPassed = true;
    if (symbol && symbol.quantityMode === 'quantity') {
      validationPassed = validateQuantity();
    }

    // Only place order if validation passed
    if (validationPassed) {
      if (state.useMoneyness) placeOptionsOrder();
      else placePlaceOrder();
    }
  });

  // Theme toggle
  container.querySelector('#oa-theme-btn')?.addEventListener('click', () => toggleTheme());

  // Refresh button
  container.querySelector('#oa-refresh-btn')?.addEventListener('click', () => toggleRefreshPanel());

  // Expiry slider arrows
  container.querySelector('#oa-expiry-left')?.addEventListener('click', () => scrollExpiry(-1));
  container.querySelector('#oa-expiry-right')?.addEventListener('click', () => scrollExpiry(1));

  // Strike dropdown controls
  container.querySelector('#oa-update-strikes')?.addEventListener('click', () => updateStrikesAndQuotes());
  container.querySelector('#oa-mode-toggle')?.addEventListener('click', () => toggleStrikeMode());
  container.querySelector('#oa-extend-strikes')?.addEventListener('click', () => extendStrikes());

  // Settings button
  container.querySelector('#oa-settings-btn')?.addEventListener('click', () => toggleSettingsPanel());

  // Orders button
  container.querySelector('#oa-orders-btn')?.addEventListener('click', () => toggleOrdersDropdown());

  // Orders filters (in orders tab only)
  const ordersTab = container.querySelector('#oa-tab-orders');
  if (ordersTab) {
    const orderFilterBtns = ordersTab.querySelectorAll('.oa-filter-btn');
    orderFilterBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        orderFilterBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        state.ordersFilter = e.target.dataset.filter;
        renderOrders();
      });
    });
    const defaultOrderFilter = ordersTab.querySelector(`.oa-filter-btn[data-filter="${state.ordersFilter}"]`);
    if (defaultOrderFilter) defaultOrderFilter.classList.add('active');
  }

  // Orders refresh
  container.querySelector('#oa-refresh-orders')?.addEventListener('click', () => fetchOrders());

  // Cancel all
  container.querySelector('#oa-cancel-all-btn')?.addEventListener('click', () => cancelAllOrders());

  // Tab switching
  container.querySelectorAll('.oa-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      switchBookTab(e.target.dataset.tab);
    });
  });

  // Tradebook refresh
  container.querySelector('#oa-refresh-tradebook')?.addEventListener('click', () => fetchTradebook());

  // Positions filters (in positions tab only)
  const positionsTab = container.querySelector('#oa-tab-positions');
  if (positionsTab) {
    const posFilterBtns = positionsTab.querySelectorAll('.oa-filter-btn');
    posFilterBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        posFilterBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        state.positionsFilter = e.target.dataset.filter;
        renderPositions();
      });
    });
    const defaultPosFilter = positionsTab.querySelector(`.oa-filter-btn[data-filter="${state.positionsFilter}"]`);
    if (defaultPosFilter) defaultPosFilter.classList.add('active');
  }

  // Positions refresh
  container.querySelector('#oa-refresh-positions')?.addEventListener('click', () => fetchPositions());

  // Positions close all
  container.querySelector('#oa-close-all-btn')?.addEventListener('click', () => closeAllPositions());
}

function setupQuickEvents(container) {
  container.querySelector('#le-btn')?.addEventListener('click', () => placeLegacyOrder('BUY'));
  container.querySelector('#lx-btn')?.addEventListener('click', () => placeLegacySmartOrder('BUY'));
  container.querySelector('#se-btn')?.addEventListener('click', () => placeLegacyOrder('SELL'));
  container.querySelector('#sx-btn')?.addEventListener('click', () => placeLegacySmartOrder('SELL'));
  container.querySelector('#oa-settings-btn')?.addEventListener('click', () => toggleSettingsPanel());
}

// Theme toggle
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(state.theme);
  saveSettings({ theme: state.theme });
  const btn = document.getElementById('oa-theme-btn');
  if (btn) btn.textContent = state.theme === 'dark' ? '☀️' : '🌙';
}

function applyTheme(theme) {
  const container = document.getElementById('openalgo-controls');
  if (!container) return;
  if (theme === 'light') {
    container.classList.add('oa-light-theme');
    container.classList.remove('oa-dark-theme');
  } else {
    container.classList.add('oa-dark-theme');
    container.classList.remove('oa-light-theme');
  }
}

// Refresh panel
function toggleRefreshPanel() {
  const panel = document.getElementById('oa-refresh-panel');
  if (!panel) return;
  const isHidden = panel.classList.contains('hidden');
  if (isHidden) {
    // Hide other panels directly
    const ordersDropdown = document.getElementById('oa-orders-dropdown');
    if (ordersDropdown) ordersDropdown.classList.add('hidden');
    const settingsPanel = document.getElementById('oa-settings-panel');
    if (settingsPanel) settingsPanel.classList.add('hidden');

    panel.innerHTML = buildRefreshPanel();
    setupRefreshEvents(panel);
  }
  panel.classList.toggle('hidden');
}

function buildRefreshPanel() {
  const liveClass = state.liveDataEnabled ? 'oa-btn success' : 'oa-btn';
  const liveText = state.liveDataEnabled ? '● Live' : '○ Live';
  return `
    <div class="oa-refresh-content">
      <div class="oa-refresh-row" style="justify-content:space-between;">
        <div style="display:flex;gap:8px;">
          <div class="oa-refresh-col">
            <label class="oa-small-label">Mode</label>
            <select id="oa-refresh-mode" class="oa-small-select">
              <option value="manual" ${state.refreshMode === 'manual' ? 'selected' : ''}>Manual</option>
              <option value="auto" ${state.refreshMode === 'auto' ? 'selected' : ''}>Auto</option>
            </select>
          </div>
          <div class="oa-refresh-col" id="oa-interval-group" ${state.refreshMode === 'manual' ? 'style="display:none"' : ''}>
            <label class="oa-small-label">Sec</label>
            <input id="oa-refresh-interval" type="number" min="3" max="60" value="${state.refreshIntervalSec}" class="oa-small-input">
          </div>
        </div>
        <button id="oa-live-data-btn" class="${liveClass}" style="align-self:flex-end;font-size:0.75rem;padding:0.25rem 0.5rem;height:auto;" title="Toggle WebSocket live data streaming">
          ${liveText}
        </button>
      </div>
      <div class="oa-checkbox-inline">
        <label class="oa-checkbox-compact"><input type="checkbox" id="oa-ref-funds" ${state.refreshAreas.funds ? 'checked' : ''}> Funds</label>
        <label class="oa-checkbox-compact"><input type="checkbox" id="oa-ref-underlying" ${state.refreshAreas.underlying ? 'checked' : ''}> Undly</label>
        <label class="oa-checkbox-compact"><input type="checkbox" id="oa-ref-selectedStrike" ${state.refreshAreas.selectedStrike ? 'checked' : ''}> Strike</label>
      </div>
      <div class="oa-refresh-actions">
        <button id="oa-refresh-save" class="oa-btn primary">Save</button>
        <button id="oa-refresh-now" class="oa-btn success">Now</button>
      </div>
    </div>
  `;
}

function setupRefreshEvents(panel) {
  panel.querySelector('#oa-refresh-mode')?.addEventListener('change', (e) => {
    const intGroup = panel.querySelector('#oa-interval-group');
    if (intGroup) intGroup.style.display = e.target.value === 'manual' ? 'none' : '';
  });

  // Live data button - toggle immediately and rebuild panel to show updated state
  panel.querySelector('#oa-live-data-btn')?.addEventListener('click', () => {
    const newState = !state.liveDataEnabled;
    toggleLiveData(newState);
    showNotification(newState ? 'Live data enabled' : 'Live data disabled', 'success');
    // Rebuild panel to update button appearance
    panel.innerHTML = buildRefreshPanel();
    setupRefreshEvents(panel);
  });

  panel.querySelector('#oa-refresh-save')?.addEventListener('click', async () => {
    state.refreshMode = panel.querySelector('#oa-refresh-mode').value;
    state.refreshIntervalSec = parseInt(panel.querySelector('#oa-refresh-interval').value) || 5;
    state.refreshAreas = {
      funds: panel.querySelector('#oa-ref-funds').checked,
      underlying: panel.querySelector('#oa-ref-underlying').checked,
      selectedStrike: panel.querySelector('#oa-ref-selectedStrike').checked
    };
    await saveSettings({ refreshMode: state.refreshMode, refreshIntervalSec: state.refreshIntervalSec, refreshAreas: state.refreshAreas });
    startDataRefresh();
    toggleRefreshPanel();
    showNotification('Refresh settings saved!', 'success');
  });
  panel.querySelector('#oa-refresh-now')?.addEventListener('click', () => manualRefresh());
}

// Expiry slider scroll
function scrollExpiry(direction) {
  const slider = document.getElementById('oa-expiry-slider');
  if (slider) slider.scrollBy({ left: direction * 80, behavior: 'smooth' });
}

// Loading indicators
function showLoadingIndicator(area) {
  const el = document.getElementById(`oa-${area === 'underlying' ? 'underlying-ltp' : area}`);
  if (el) el.classList.add('oa-loading');
}

function hideLoadingIndicator(area) {
  const el = document.getElementById(`oa-${area === 'underlying' ? 'underlying-ltp' : area}`);
  if (el) el.classList.remove('oa-loading');
}

// Strike dropdown control functions
async function updateStrikesAndQuotes() {
  const btn = document.getElementById('oa-update-strikes');
  const strikeCol = document.getElementById('oa-strike-col');
  const ltpCol = document.getElementById('oa-ltp-col');

  // Always show loading on button
  btn?.classList.add('oa-loading');

  if (state.strikeMode === 'moneyness') {
    // Show loading on strike column first for moneyness mode
    strikeCol?.classList.add('oa-loading');
    ltpCol?.classList.add('oa-loading');

    // Re-fetch moneyness-based strikes using optionsymbol API
    // This also fetches LTPs, so no need to call fetchStrikeLTPs separately
    await fetchStrikeChain();

    strikeCol?.classList.remove('oa-loading');
    ltpCol?.classList.remove('oa-loading');
  } else {
    // In strike mode, only show loading on LTP column (only quotes update)
    ltpCol?.classList.add('oa-loading');
    await _fetchStrikeLTPs(); // Ensure using internal function name if alias doesn't work
    ltpCol?.classList.remove('oa-loading');
  }

  // Update price if MARKET order
  if (state.orderType === 'MARKET') {
    updatePriceDisplay();
  }

  // Remove all loading
  btn?.classList.remove('oa-loading');
}

async function toggleStrikeMode() {
  state.strikeMode = state.strikeMode === 'moneyness' ? 'strike' : 'moneyness';
  state.useMoneyness = state.strikeMode === 'moneyness';
  await saveSettings({ strikeMode: state.strikeMode });

  // Update mode button label
  const btn = document.getElementById('oa-mode-toggle');
  if (btn) btn.textContent = state.strikeMode === 'moneyness' ? 'M' : 'S';

  // Update hover text for update button
  const updateBtn = document.getElementById('oa-update-strikes');
  if (updateBtn) {
    updateBtn.title = state.strikeMode === 'moneyness'
      ? 'Update Strikes and LTP'
      : 'Update LTP';
  }

  // Update strike dropdown to show editable/non-editable strike
  updateStrikeDropdown();
  showNotification(`Mode: ${state.strikeMode === 'moneyness' ? 'Moneyness' : 'Strike'}`, 'success');
}

async function extendStrikes() {
  // Prevent concurrent executions
  if (isExtendingStrikes) return;
  isExtendingStrikes = true;

  try {
    const symbol = getActiveSymbol();
    if (!symbol || !state.selectedExpiry || !strikeInterval || !cachedATMStrike) return;

    const btn = document.getElementById('oa-extend-strikes');
    if (btn) btn.classList.add('oa-loading');

    state.extendLevel++;
    const newITMLevel = state.extendLevel;
    const newOTMLevel = state.extendLevel;

    // Calculate direction based on option type
    // For CE: ITM is below ATM (lower strike), OTM is above ATM (higher strike)
    // For PE: ITM is above ATM (higher strike), OTM is below ATM (lower strike)
    const isPE = state.optionType === 'PE';
    const itmDirection = isPE ? 1 : -1;
    const otmDirection = isPE ? -1 : 1;

    // Dynamically calculate new strikes using strikeInterval
    const newStrikes = [];

    // New ITM strike
    const itmStrikeValue = cachedATMStrike + (newITMLevel * strikeInterval * itmDirection);
    newStrikes.push({
      offset: `ITM${newITMLevel}`,
      symbol: `${symbol.symbol}${state.selectedExpiry}${itmStrikeValue}${state.optionType}`,
      exchange: symbol.optionExchange,
      strike: itmStrikeValue,
      lotsize: state.lotSize,
      ltp: 0,
      prevClose: 0
    });

    // New OTM strike
    const otmStrikeValue = cachedATMStrike + (newOTMLevel * strikeInterval * otmDirection);
    newStrikes.push({
      offset: `OTM${newOTMLevel}`,
      symbol: `${symbol.symbol}${state.selectedExpiry}${otmStrikeValue}${state.optionType}`,
      exchange: symbol.optionExchange,
      strike: otmStrikeValue,
      lotsize: state.lotSize,
      ltp: 0,
      prevClose: 0
    });

    // Add to chain (ITM at beginning, OTM at end)
    const itmStrike = newStrikes.find(s => s.offset === `ITM${newITMLevel}`);
    const otmStrike = newStrikes.find(s => s.offset === `OTM${newOTMLevel}`);
    if (itmStrike) strikeChain.unshift(itmStrike);
    if (otmStrike) strikeChain.push(otmStrike);

    // Fetch LTPs for new strikes via multiquotes
    if (newStrikes.length > 0) {
      const symbols = newStrikes.map(s => ({ symbol: s.symbol, exchange: s.exchange }));
      const result = await apiCall('/api/v1/multiquotes', { symbols });
      if (result.status === 'success' && result.results) {
        result.results.forEach(r => {
          const strike = strikeChain.find(s => s.symbol === r.symbol);
          if (strike && r.data) {
            strike.ltp = r.data.ltp || 0;
            strike.prevClose = r.data.prev_close || 0;
          }
        });
      }
    }

    updateStrikeDropdown();
    if (btn) btn.classList.remove('oa-loading');
  } finally {
    isExtendingStrikes = false;
  }
}

// Build dynamic symbol for Strike mode
function buildDynamicSymbol(strike) {
  const symbol = getActiveSymbol();
  if (!symbol) return null;

  // Format: BANKNIFTY05DEC2453600CE
  const expiry = state.selectedExpiry; // Already in DDMMMYY format
  return `${symbol.symbol}${expiry}${strike}${state.optionType}`;
}

// Settings panel
function toggleSettingsPanel() {
  const panel = document.getElementById('oa-settings-panel');
  if (!panel) return;
  const isHidden = panel.classList.contains('hidden');
  if (isHidden) {
    // Hide other panels directly
    const ordersDropdown = document.getElementById('oa-orders-dropdown');
    if (ordersDropdown) ordersDropdown.classList.add('hidden');
    const refreshPanel = document.getElementById('oa-refresh-panel');
    if (refreshPanel) refreshPanel.classList.add('hidden');

    panel.innerHTML = buildSettingsPanel();
    setupSettingsEvents(panel);
  }
  panel.classList.toggle('hidden');
}

function buildSettingsPanel() {
  const isScalping = settings.uiMode === 'scalping';
  return `
    <div class="oa-settings-content">
      <h3>Settings</h3>
      <div class="oa-form-group">
        <label>Host URL</label>
        <input id="oa-host" type="text" value="${settings.hostUrl}">
      </div>
      <div class="oa-form-group">
        <label>API Key</label>
        <input id="oa-apikey" type="text" value="${settings.apiKey}">
      </div>
      <div class="oa-form-group">
        <label>WebSocket URL</label>
        <input id="oa-wsurl" type="text" value="${state.wsUrl}" placeholder="ws://127.0.0.1:8765">
      </div>
      <div class="oa-form-group">
        <label>UI Mode</label>
        <select id="oa-uimode">
          <option value="scalping" ${isScalping ? 'selected' : ''}>Options Scalping</option>
          <option value="quick" ${!isScalping ? 'selected' : ''}>Quick Orders (LE/LX/SE/SX)</option>
        </select>
      </div>
      ${isScalping ? buildSymbolSettings() : buildQuickSettings()}
      <button id="oa-save-settings" class="oa-btn primary">Save Settings</button>
    </div>
  `;
}

function buildSymbolSettings() {
  return `
    <h4>Symbols</h4>
    <div id="oa-symbol-list">
      ${settings.symbols.map(s => `
        <div class="oa-symbol-item" data-id="${s.id}">
          <span class="oa-symbol-info">${s.symbol} (${s.exchange})</span>
          <div class="oa-symbol-actions">
            <button class="oa-edit-symbol" title="Edit">✏️</button>
            <button class="oa-remove-symbol" title="Remove">✕</button>
          </div>
        </div>
      `).join('')}
    </div>
    <div id="oa-edit-symbol-form" class="oa-edit-form hidden"></div>
    <div class="oa-add-symbol">
      <input id="oa-new-symbol" type="text" placeholder="Symbol (e.g. NIFTY)">
      <select id="oa-new-exchange">
        <option value="NSE_INDEX">NSE_INDEX</option>
        <option value="NSE">NSE</option>
        <option value="BSE_INDEX">BSE_INDEX</option>
        <option value="BSE">BSE</option>
      </select>
      <select id="oa-new-product">
        <option value="MIS">MIS</option>
        <option value="NRML">NRML</option>
      </select>
      <button id="oa-add-symbol" class="oa-btn success">Add</button>
    </div>
  `;
}

function buildQuickSettings() {
  return `
    <div class="oa-form-group">
      <label>Symbol</label>
      <input id="oa-quick-symbol" type="text" value="${settings.symbol}">
    </div>
    <div class="oa-form-group">
      <label>Exchange</label>
      <select id="oa-quick-exchange">
        <option value="NSE" ${settings.exchange === 'NSE' ? 'selected' : ''}>NSE</option>
        <option value="NFO" ${settings.exchange === 'NFO' ? 'selected' : ''}>NFO</option>
        <option value="BSE" ${settings.exchange === 'BSE' ? 'selected' : ''}>BSE</option>
        <option value="BFO" ${settings.exchange === 'BFO' ? 'selected' : ''}>BFO</option>
      </select>
    </div>
    <div class="oa-form-group">
      <label>Product</label>
      <select id="oa-quick-product">
        <option value="MIS" ${settings.product === 'MIS' ? 'selected' : ''}>MIS</option>
        <option value="NRML" ${settings.product === 'NRML' ? 'selected' : ''}>NRML</option>
        <option value="CNC" ${settings.product === 'CNC' ? 'selected' : ''}>CNC</option>
      </select>
    </div>
    <div class="oa-form-group">
      <label>Quantity</label>
      <input id="oa-quick-qty" type="number" value="${settings.quantity}">
    </div>
  `;
}

function setupSettingsEvents(panel) {
  // Add symbol
  panel.querySelector('#oa-add-symbol')?.addEventListener('click', async () => {
    const symbolInput = panel.querySelector('#oa-new-symbol');
    const exchange = panel.querySelector('#oa-new-exchange').value;
    const product = panel.querySelector('#oa-new-product').value;
    const symbolName = symbolInput.value.trim().toUpperCase();
    if (!symbolName) return;

    const newSymbol = {
      id: uuid(),
      symbol: symbolName,
      exchange: exchange,
      optionExchange: deriveOptionExchange(exchange),
      productType: product,
      quantityMode: 'lots' // Default to lots mode
    };
    settings.symbols.push(newSymbol);
    if (!settings.activeSymbolId) settings.activeSymbolId = newSymbol.id;
    await saveSettings({ symbols: settings.symbols, activeSymbolId: settings.activeSymbolId });
    symbolInput.value = '';

    // Update UI dynamically
    panel.innerHTML = buildSettingsPanel();
    setupSettingsEvents(panel);

    // Update main symbol dropdown
    const select = document.getElementById('oa-symbol-select');
    if (select) {
      select.innerHTML = settings.symbols.map(s => `<option value="${s.id}" ${s.id === settings.activeSymbolId ? 'selected' : ''}>${s.symbol}</option>`).join('') + (settings.symbols.length === 0 ? '<option value="">Add symbol in settings</option>' : '');
    }
    showNotification('Symbol added!', 'success');
  });

  // Remove symbol
  panel.querySelectorAll('.oa-remove-symbol').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.oa-symbol-item').dataset.id;
      settings.symbols = settings.symbols.filter(s => s.id !== id);
      if (settings.activeSymbolId === id) settings.activeSymbolId = settings.symbols[0]?.id || '';
      await saveSettings({ symbols: settings.symbols, activeSymbolId: settings.activeSymbolId });

      // Update UI dynamically
      panel.innerHTML = buildSettingsPanel();
      setupSettingsEvents(panel);

      // Update main symbol dropdown
      const select = document.getElementById('oa-symbol-select');
      if (select) {
        select.innerHTML = settings.symbols.map(s => `<option value="${s.id}" ${s.id === settings.activeSymbolId ? 'selected' : ''}>${s.symbol}</option>`).join('') + (settings.symbols.length === 0 ? '<option value="">Add symbol in settings</option>' : '');
      }
      showNotification('Symbol removed!', 'success');
    });
  });

  // Edit symbol
  panel.querySelectorAll('.oa-edit-symbol').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.target.closest('.oa-symbol-item').dataset.id;
      const sym = settings.symbols.find(s => s.id === id);
      if (!sym) return;
      const form = panel.querySelector('#oa-edit-symbol-form');
      form.classList.remove('hidden');
      form.innerHTML = `
        <div class="oa-edit-row">
          <input id="oa-edit-name" type="text" value="${sym.symbol}" placeholder="Symbol">
          <select id="oa-edit-exchange">
            <option value="NSE_INDEX" ${sym.exchange === 'NSE_INDEX' ? 'selected' : ''}>NSE_INDEX</option>
            <option value="NSE" ${sym.exchange === 'NSE' ? 'selected' : ''}>NSE</option>
            <option value="BSE_INDEX" ${sym.exchange === 'BSE_INDEX' ? 'selected' : ''}>BSE_INDEX</option>
            <option value="BSE" ${sym.exchange === 'BSE' ? 'selected' : ''}>BSE</option>
          </select>
          <select id="oa-edit-product">
            <option value="MIS" ${sym.productType === 'MIS' ? 'selected' : ''}>MIS</option>
            <option value="NRML" ${sym.productType === 'NRML' ? 'selected' : ''}>NRML</option>
          </select>
          <button id="oa-save-edit" class="oa-btn primary" data-id="${id}">Save</button>
          <button id="oa-cancel-edit" class="oa-btn">Cancel</button>
        </div>
      `;
      form.querySelector('#oa-save-edit')?.addEventListener('click', async () => {
        sym.symbol = form.querySelector('#oa-edit-name').value.trim().toUpperCase();
        sym.exchange = form.querySelector('#oa-edit-exchange').value;
        sym.optionExchange = deriveOptionExchange(sym.exchange);
        sym.productType = form.querySelector('#oa-edit-product').value;
        await saveSettings({ symbols: settings.symbols });
        // Update UI without reload
        form.classList.add('hidden');
        panel.innerHTML = buildSettingsPanel();
        setupSettingsEvents(panel);
        // Update symbol dropdown in main UI
        const select = document.getElementById('oa-symbol-select');
        if (select) {
          select.innerHTML = settings.symbols.map(s => `<option value="${s.id}" ${s.id === settings.activeSymbolId ? 'selected' : ''}>${s.symbol}</option>`).join('');
        }
        showNotification('Symbol updated!', 'success');
      });
      form.querySelector('#oa-cancel-edit')?.addEventListener('click', () => form.classList.add('hidden'));
    });
  });

  // Save settings
  panel.querySelector('#oa-save-settings')?.addEventListener('click', async () => {
    const newWsUrl = panel.querySelector('#oa-wsurl')?.value || 'ws://127.0.0.1:8765';
    state.wsUrl = newWsUrl;

    const newSettings = {
      hostUrl: panel.querySelector('#oa-host').value,
      apiKey: panel.querySelector('#oa-apikey').value,
      uiMode: panel.querySelector('#oa-uimode').value,
      wsUrl: newWsUrl
    };

    if (newSettings.uiMode === 'quick') {
      newSettings.symbol = panel.querySelector('#oa-quick-symbol')?.value || '';
      newSettings.exchange = panel.querySelector('#oa-quick-exchange')?.value || 'NSE';
      newSettings.product = panel.querySelector('#oa-quick-product')?.value || 'MIS';
      newSettings.quantity = panel.querySelector('#oa-quick-qty')?.value || '1';
    }

    const modeChanged = newSettings.uiMode !== settings.uiMode;
    await saveSettings(newSettings);
    showNotification('Settings saved!', 'success');

    // Apply UI mode change without full reload - rebuild UI
    if (modeChanged) {
      const container = document.getElementById('openalgo-controls');
      if (container) {
        // Update container class to fix width immediately
        container.className = newSettings.uiMode === 'scalping' ? 'oa-container oa-scalping' : 'oa-container oa-quick';
        container.innerHTML = newSettings.uiMode === 'scalping' ? buildScalpingUI() : buildQuickUI();
        if (newSettings.uiMode === 'scalping') {
          setupScalpingEvents(container);
          applyTheme(state.theme);
          if (settings.apiKey && settings.hostUrl) {
            fetchExpiry();
            startDataRefresh();
          }
        } else {
          setupQuickEvents(container);
        }
      }
    }
    toggleSettingsPanel();
  });
}

// Draggable functionality
function makeDraggable(el) {
  let isDragging = false, offsetX, offsetY;
  el.style.position = 'fixed';
  el.style.zIndex = '10000';
  el.style.top = '100px';
  el.style.left = '20px';

  el.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
    isDragging = true;
    offsetX = e.clientX - el.getBoundingClientRect().left;
    offsetY = e.clientY - el.getBoundingClientRect().top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      el.style.left = (e.clientX - offsetX) + 'px';
      el.style.top = (e.clientY - offsetY) + 'px';
    }
  });

  document.addEventListener('mouseup', () => isDragging = false);
}

// Inject CSS styles
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    /* Base container - Compact sizing */
    .oa-container { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #000; color: #eee; border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); padding: 8px; font-size: 11px; position: relative; }
    .oa-container.oa-scalping { min-width: 360px; }
    .oa-container.oa-quick { min-width: auto; }
    .oa-container.oa-dark-theme { background: #000; color: #eee; }
    .oa-container.oa-light-theme { background: #fff; color: #222; box-shadow: 0 4px 20px rgba(0,0,0,0.15); }
    .oa-light-theme .oa-select, .oa-light-theme .oa-toggle, .oa-light-theme .oa-strike-select, .oa-light-theme .oa-lot-btn, .oa-light-theme .oa-price-input { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-lots input { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-lots input.editable { border-color: #3b82f6 !important; background: #fff !important; }
    .oa-light-theme .oa-lots input[readonly]:hover { background: #e8e8e8 !important; }
    .oa-light-theme .oa-small-select, .oa-light-theme .oa-small-input { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-add-symbol input, .oa-light-theme .oa-add-symbol select { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-strike-dropdown, .oa-light-theme .oa-settings-panel, .oa-light-theme .oa-refresh-panel { background: #fff !important; border-color: #ddd !important; }
    .oa-light-theme .oa-expiry-btn { background: #e8e8e8 !important; color: #666 !important; }
    .oa-light-theme .oa-expiry-btn.active { background: #5c6bc0 !important; color: #fff !important; }
    .oa-light-theme .oa-strike-row:hover { background: #f5f5f5 !important; }
    .oa-light-theme .oa-strike-row.selected { background: #bbdefb !important; }
    .oa-light-theme .oa-strike-row.atm { background: #c8e6c9 !important; }
    .oa-light-theme .oa-form-group input, .oa-light-theme .oa-form-group select { background: #f5f5f5 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-symbol-item { background: #f0f0f0 !important; }
    .oa-light-theme .oa-mode-slider { background-color: #ddd !important; }
    .oa-light-theme .oa-mode-switch:checked + .oa-mode-slider { background-color: #5c6bc0 !important; }
    .oa-light-theme .oa-strike-actions { background: #f5f5f5; border-top: 1px solid #ddd; }
    .oa-light-theme .oa-action-btn { background: #f0f0f0 !important; color: #333 !important; border: 1px solid #ccc !important; border-radius: 3px !important; font-size: 9px !important; cursor: pointer !important; text-align: center !important; flex: 1 !important; padding: 5px 8px !important; }
    .oa-light-theme .oa-action-btn:hover { background: #e0e0e0; color: #000; }
    .oa-light-theme .oa-strike { color: #222 !important; }
    .oa-light-theme .oa-strike.editable { color: #3b82f6 !important; }
    .oa-drag-handle { height: 3px; background: #333; border-radius: 2px; margin: -4px -4px 6px; cursor: move; }
    .oa-light-theme .oa-drag-handle { background: #ccc !important; }
    
    /* Header */
    .oa-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
    .oa-select { background: #111; color: #fff; border: 1px solid #333; border-radius: 4px; padding: 4px 8px; font-weight: 600; font-size: 11px; }
    .oa-ltp-display { font-size: 11px; font-weight: 600; display: flex; align-items: center; gap: 4px; }
    .oa-ltp-value { font-weight: 700; }
    .oa-change-text { color: #999; font-size: 10px; }
    .oa-mode-indicator { font-size: 9px; color: #5c6bc0; font-weight: 700; padding: 2px 6px; border-radius: 3px; background: rgba(92, 107, 192, 0.1); cursor: pointer; }
    .oa-mode-indicator:hover { filter: brightness(1.1); }
    .oa-funds { font-size: 10px; margin-left: auto; }
    .positive { color: #00e676 !important; }
    .negative { color: #ff5252 !important; }
    .oa-icon-btn { background: transparent; border: none; color: #666; font-size: 14px; cursor: pointer; padding: 2px 6px; }
    .oa-icon-btn:hover { color: #fff; }
    .oa-light-theme .oa-icon-btn { color: #999 !important; }
    .oa-light-theme .oa-icon-btn:hover { color: #333 !important; }
    .oa-header-btn { background: transparent !important; color: #ccc !important; border: 1px solid #444 !important; border-radius: 4px !important; padding: 3px 8px !important; font-size: 10px !important; font-weight: 600 !important; cursor: pointer !important; }
    .oa-header-btn:hover { border-color: #888 !important; color: #fff !important; }
    .oa-light-theme .oa-header-btn { color: #333 !important; border-color: #ccc !important; background: #f5f5f5 !important; }
    .oa-light-theme .oa-header-btn:hover { border-color: #666 !important; color: #000 !important; }
    
    /* Controls row */
    .oa-controls { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    .oa-toggle { background: #222 !important; color: #fff !important; border: none !important; border-radius: 4px !important; padding: 5px 10px !important; font-weight: 700 !important; cursor: pointer !important; text-transform: uppercase !important; font-size: 10px !important; height: auto !important; width: auto !important; }
    .oa-toggle.buy { background: #00c853 !important; }
    .oa-toggle.sell { background: #ff1744 !important; }
    .oa-ordertype-fixed { min-width: 55px !important; text-align: center !important; }
    .oa-strike-select { background: #111 !important; color: #fff !important; border: 1px solid #444 !important; border-radius: 4px !important; padding: 5px 8px !important; cursor: pointer !important; min-width: 80px !important; font-size: 10px !important; height: auto !important; }
    .oa-lots { display: flex; align-items: center; gap: 2px; }
    .oa-lot-btn { background: #222 !important; color: #fff !important; border: none !important; border-radius: 3px !important; width: 22px !important; height: 22px !important; cursor: pointer !important; font-size: 14px !important; padding: 0 !important; margin: 0 !important; }
    .oa-lot-btn:disabled { background: #333 !important; color: #666 !important; cursor: not-allowed !important; }
    .oa-light-theme .oa-lot-btn:disabled { background: #ccc !important; color: #999 !important; }
    .oa-lot-btn:disabled { background: #333 !important; color: #666 !important; cursor: not-allowed !important; }
    .oa-light-theme .oa-lot-btn:disabled { background: #ccc !important; color: #999 !important; }
    .oa-lots input { width: 80px !important; background: #111 !important; color: #fff !important; border: 1px solid #333 !important; border-radius: 4px !important; text-align: center !important; padding: 5px 5px !important; font-size: 10px !important; height: 24px !important; box-sizing: border-box !important; }
    .oa-lots input:disabled { background: #222 !important; color: #666 !important; cursor: not-allowed !important; }
    .oa-lots input:disabled { background: #222 !important; color: #666 !important; cursor: not-allowed !important; }
    .oa-lots input.editable { border-color: #5c6bc0 !important; background: #1a1a2e !important; }
    .oa-lots input[readonly] { cursor: pointer !important; }
    .oa-lots input[readonly]:hover { background: #1a1a2e !important; }
    .oa-lots-label { font-size: 9px; color: #666; }
    
    /* Input wrapper with update button */
    .oa-input-wrapper { position: relative !important; display: inline-flex !important; align-items: center !important; }
    .oa-input-wrapper input { padding-right: 18px !important; }
    .oa-input-update { position: absolute !important; right: 2px !important; top: 50% !important; transform: translateY(-50%) !important; background: transparent !important; border: none !important; color: #666 !important; font-size: 10px !important; cursor: pointer !important; padding: 2px !important; line-height: 1 !important; }
    .oa-input-update:hover:not(:disabled) { color: #00e676; }
    .oa-input-update:disabled { color: #666; cursor: not-allowed; }
    .oa-lots .oa-input-wrapper input { width: 70px !important; background: #111 !important; color: #fff !important; border: 1px solid #333 !important; border-radius: 4px !important; text-align: center !important; padding: 5px 18px 5px 5px !important; font-size: 10px !important; height: 24px !important; box-sizing: border-box !important; }
    .oa-lots input.loading { text-align: center; }
    .oa-light-theme .oa-lots .oa-input-wrapper input { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-lots input.editable { border-color: #3b82f6 !important; background: #fff !important; }
    .oa-light-theme .oa-lots input[readonly]:hover { background: #e8e8e8 !important; }
    .price-wrapper { margin-right: 2px; }
    .oa-price-input { width: 55px !important; background: #111 !important; color: #fff !important; border: 1px solid #333 !important; border-radius: 4px !important; padding: 5px 18px 5px 5px !important; text-align: right !important; font-size: 10px !important; height: 24px !important; box-sizing: border-box !important; }
    .oa-price-input:disabled { opacity: 0.5; }
    .netpos-wrapper { margin-right: 2px; }
    /* Net pos button and input */
    .oa-netpos-btn { background: #222 !important; color: #ccc !important; border: 1px solid #333 !important; border-radius: 4px !important; padding: 4px 6px !important; cursor: pointer !important; font-size: 11px !important; font-weight: 700 !important; white-space: nowrap !important; height: auto !important; width: auto !important; }
    .oa-netpos-btn:hover { background: #333 !important; color: #fff !important; }
    .oa-netpos-btn:hover { background: #333 !important; color: #fff !important; }
    .oa-netpos-input-wrapper { position: relative !important; display: inline-flex !important; align-items: center !important; margin-left: 2px !important; }
    .oa-netpos-input { width: 70px !important; background: #111 !important; color: #fff !important; border: 1px solid #333 !important; border-radius: 4px !important; padding: 5px 20px 5px 18px !important; text-align: center !important; font-size: 10px !important; height: 24px !important; box-sizing: border-box !important; }
    .oa-netpos-label { position: absolute !important; left: 6px !important; top: 50% !important; transform: translateY(-50%) !important; color: #666 !important; font-size: 12px !important; font-weight: 700 !important; pointer-events: auto !important; }
    .oa-netpos-input.editable { border-color: #5c6bc0; background: #1a1a2e; }
    .oa-netpos-input[readonly] { cursor: pointer; }
    .oa-netpos-input[readonly]:hover { background: #1a1a2e !important; }

    /* Light theme styles for net pos */
    .oa-light-theme .oa-netpos-input { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; padding: 5px 20px 5px 18px !important; }
    .oa-light-theme .oa-netpos-input.editable { border-color: #3b82f6 !important; background: #fff !important; }
    .oa-light-theme .oa-netpos-input[readonly]:hover { background: #e8e8e8 !important; }
    .oa-light-theme .oa-netpos-label { color: #999 !important; }

    /* Remove spinner arrows from number inputs */
    input[type="text"]::-webkit-outer-spin-button, input[type="text"]::-webkit-inner-spin-button,
    input[type="number"]::-webkit-outer-spin-button, input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    input[type="text"], input[type="number"] { -moz-appearance: textfield; }
    
    .oa-order-btn { padding: 6px 12px !important; border: none !important; border-radius: 6px !important; font-weight: 700 !important; cursor: pointer !important; text-transform: uppercase !important; font-size: 10px !important; white-space: nowrap !important; height: auto !important; width: auto !important; }
    .oa-order-btn.buy { background: linear-gradient(135deg, #00c853, #00e676) !important; color: #000 !important; }
    .oa-order-btn.sell { background: linear-gradient(135deg, #ff1744, #ff5252) !important; color: #fff !important; }
    .oa-resize-btn { padding: 6px 10px !important; border: none !important; border-radius: 6px !important; font-weight: 700 !important; cursor: pointer !important; font-size: 10px !important; white-space: nowrap !important; background: #222 !important; color: #eee !important; border: 1px solid #333 !important; height: auto !important; width: auto !important; }
    .oa-resize-btn.neutral { background: #222 !important; color: #eee !important; }
    .oa-resize-btn.buy { background: linear-gradient(135deg, #00c853, #00e676) !important; color: #000 !important; }
    .oa-resize-btn.sell { background: linear-gradient(135deg, #ff1744, #ff5252) !important; color: #fff !important; }
    .oa-light-theme .oa-resize-btn { background: #f0f0f0 !important; color: #222 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-resize-btn.buy { color: #000 !important; }
    .oa-light-theme .oa-resize-btn.sell { color: #fff !important; }
    
    /* SL Button */
    .oa-sl-btn { padding: 6px 10px !important; border: none !important; border-radius: 6px !important; font-weight: 700 !important; cursor: pointer !important; font-size: 10px !important; white-space: nowrap !important; background: linear-gradient(180deg, #ff6b35 0%, #e55039 100%) !important; color: white !important; height: auto !important; width: auto !important; transition: all 0.2s !important; }
    .oa-sl-btn.neutral { background: #4a4a5a !important; color: #888 !important; }
    .oa-sl-btn:disabled { opacity: 0.5 !important; cursor: not-allowed !important; }
    .oa-sl-btn:not(:disabled):hover { transform: translateY(-1px) !important; box-shadow: 0 2px 8px rgba(255, 107, 53, 0.4) !important; }
    .oa-sl-btn.has-orders { animation: slPulse 2s infinite !important; }
    @keyframes slPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(255, 107, 53, 0.4); } 50% { box-shadow: 0 0 0 4px rgba(255, 107, 53, 0); } }
    .oa-light-theme .oa-sl-btn { background: linear-gradient(180deg, #ff6b35 0%, #e55039 100%) !important; }
    .oa-light-theme .oa-sl-btn.neutral { background: #ddd !important; color: #888 !important; }
    
    /* SL Panel */
    .oa-sl-panel { position: absolute !important; top: 100% !important; right: 0 !important; width: 340px !important; max-height: 350px !important; background: #1e1e2e !important; border-radius: 12px !important; box-shadow: 0 8px 32px rgba(0,0,0,0.4) !important; overflow: hidden !important; z-index: 1002 !important; margin-top: 8px !important; }
    .oa-sl-panel.hidden { display: none !important; }
    .oa-sl-header { display: flex !important; justify-content: space-between !important; align-items: center !important; padding: 10px 12px !important; background: rgba(255,107,53,0.1) !important; border-bottom: 1px solid rgba(255,107,53,0.2) !important; font-size: 11px !important; font-weight: 600 !important; color: #ff6b35 !important; }
    .oa-sl-position-info { font-size: 10px !important; color: #888 !important; }
    .oa-sl-footer { padding: 8px 10px !important; background: rgba(0,0,0,0.2) !important; border-top: 1px solid rgba(255,255,255,0.05) !important; }
    .oa-sl-footer-row { display: flex !important; align-items: center !important; justify-content: space-between !important; gap: 8px !important; }
    .oa-sl-remaining { display: flex !important; align-items: center !important; gap: 4px !important; font-size: 10px !important; color: #ccc !important; }
    .oa-sl-input { width: 40px !important; padding: 4px 4px !important; background: rgba(255,255,255,0.1) !important; border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 4px !important; color: #fff !important; font-size: 10px !important; text-align: center !important; }
    .oa-sl-add-btn { padding: 4px 8px !important; font-size: 9px !important; font-weight: 600 !important; background: linear-gradient(180deg, #00c853 0%, #00a843 100%) !important; color: white !important; border: none !important; border-radius: 4px !important; cursor: pointer !important; white-space: nowrap !important; }
    .oa-sl-add-btn:hover { background: linear-gradient(180deg, #00a843 0%, #008833 100%) !important; }
    .oa-sl-refresh-btn { padding: 2px 6px !important; font-size: 12px !important; background: transparent !important; color: #888 !important; border: 1px solid rgba(255,255,255,0.2) !important; border-radius: 4px !important; cursor: pointer !important; transition: all 0.2s !important; }
    .oa-sl-refresh-btn:hover { color: #ff6b35 !important; border-color: #ff6b35 !important; }
    .oa-sl-refresh-btn.spinning { animation: spin 0.8s linear infinite !important; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .oa-sl-actions { display: flex !important; gap: 6px !important; }
    .oa-footer-btn.small { padding: 4px 8px !important; font-size: 9px !important; }
    .oa-footer-btn.danger { background: #e55039 !important; color: white !important; }
    .oa-footer-btn.danger:hover { background: #c0392b !important; }
    .oa-sl-order-item { padding: 8px 10px !important; border-bottom: 1px solid rgba(255,255,255,0.05) !important; display: flex !important; justify-content: space-between !important; align-items: center !important; }
    .oa-sl-order-item:hover { background: rgba(255,255,255,0.03) !important; }
    .oa-sl-order-info { font-size: 10px !important; flex: 1 !important; }
    .oa-sl-order-details { color: #888 !important; font-size: 9px !important; }
    .oa-sl-checkbox { margin-right: 8px !important; }
    .oa-sl-action-tag { display: inline-block !important; padding: 1px 4px !important; border-radius: 3px !important; font-size: 8px !important; font-weight: 700 !important; margin-right: 4px !important; }
    .oa-sl-action-tag.buy { background: rgba(0,200,83,0.2) !important; color: #00c853 !important; }
    .oa-sl-action-tag.sell { background: rgba(255,23,68,0.2) !important; color: #ff1744 !important; }
    .oa-light-theme .oa-sl-panel { background: #fff !important; box-shadow: 0 8px 32px rgba(0,0,0,0.15) !important; }
    .oa-light-theme .oa-sl-header { background: rgba(255,107,53,0.1) !important; }
    .oa-light-theme .oa-sl-footer { background: #f5f5f5 !important; border-top: 1px solid #eee !important; }
    .oa-light-theme .oa-sl-remaining { color: #333 !important; }
    .oa-light-theme .oa-sl-input { background: #fff !important; border: 1px solid #ddd !important; color: #333 !important; }
    .oa-light-theme .oa-sl-order-item { border-bottom-color: #eee !important; }
    .oa-light-theme .oa-sl-order-item:hover { background: #f9f9f9 !important; }
    .oa-light-theme .oa-sl-add-btn { background: linear-gradient(180deg, #00c853 0%, #00a843 100%) !important; }
    
    /* Strike dropdown - left aligned */
    .oa-strike-dropdown { position: absolute; top: 100%; left: 0; background: #000; border: 1px solid #222; border-radius: 6px; margin-top: 4px; max-height: 280px; overflow: hidden; z-index: 100; width: 240px; }
    .oa-strike-dropdown.hidden { display: none; }
    .oa-expiry-container { display: flex; align-items: center; border-bottom: 1px solid #222; }
    .oa-expiry-arrow { background: transparent; border: none; color: #666; font-size: 16px; cursor: pointer; padding: 4px 6px; }
    .oa-expiry-arrow:hover { color: #fff; }
    .oa-expiry-slider { display: flex; gap: 4px; padding: 6px; overflow-x: auto; flex: 1; scrollbar-width: none; }
    .oa-expiry-slider::-webkit-scrollbar { display: none; }
    .oa-expiry-btn { background: #111; color: #888; border: none; border-radius: 3px; padding: 4px 8px; font-size: 9px; cursor: pointer; white-space: nowrap; }
    .oa-expiry-btn.active { background: #3a3a6a; color: #fff; }
    .oa-strike-header { display: grid; grid-template-columns: 0.8fr 1fr 0.6fr; padding: 4px 8px; font-size: 9px; color: #555; border-bottom: 1px solid #222; }
    .oa-strike-header span { position: relative; overflow: hidden; }
    .oa-strike-list { max-height: 150px; overflow-y: auto; }
    .oa-strike-row { display: grid; grid-template-columns: 0.8fr 1fr 0.6fr; padding: 5px 8px; cursor: pointer; font-size: 10px; }
    .oa-strike-row:hover { background: #111; }
    .oa-strike-row.atm { background: #0a2a1a; font-weight: 600; }
    .oa-strike-row.selected { background: #1a2a4a; }
    .oa-moneyness { color: #888; font-size: 9px; }
    .oa-moneyness.dim { color: #444; }
    .oa-strike { color: #fff; display: flex; align-items: center; gap: 4px; }
    .oa-strike.editable { color: #5c6bc0; }
    .oa-opt-badge { font-size: 8px; padding: 1px 3px; border-radius: 2px; font-weight: 600; }
    .oa-opt-badge.ce { background: #00c853; color: #000; }
    .oa-opt-badge.pe { background: #ff1744; color: #fff; }
    .oa-ltp { text-align: right; font-size: 10px; }
    
    /* Strike actions row */
    .oa-strike-actions { display: flex; gap: 4px; padding: 6px 8px; border-top: 1px solid #222; background: #0a0a0a; }
    .oa-action-btn { flex: 1; padding: 5px 8px; background: #222; color: #aaa; border: 1px solid #333; border-radius: 3px; font-size: 9px; cursor: pointer; text-align: center; }
    .oa-action-btn:hover { background: #333; color: #fff; }
    .oa-action-btn.oa-loading { opacity: 0.7; pointer-events: none; }
    
    /* Refresh panel - compact right aligned */
    .oa-refresh-panel { position: absolute; top: 100%; right: 0; left: auto; background: #000; border: 1px solid #222; border-radius: 6px; margin-top: 4px; z-index: 102; width: 200px; }
    .oa-refresh-panel.hidden { display: none; }
    .oa-refresh-content { padding: 8px; }
    .oa-refresh-row { display: flex; gap: 8px; margin-bottom: 6px; }
    .oa-refresh-col { display: flex; flex-direction: column; gap: 2px; }
    .oa-small-label { font-size: 8px; color: #666; }
    .oa-small-select { background: #111; color: #fff; border: 1px solid #333; border-radius: 3px; padding: 3px 4px; font-size: 9px; }
    .oa-small-input { width: 40px; background: #111; color: #fff; border: 1px solid #333; border-radius: 3px; padding: 3px 4px; font-size: 9px; text-align: center; }
    .oa-checkbox-inline { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
    .oa-checkbox-compact { display: flex; align-items: center; gap: 3px; font-size: 9px; color: #aaa; cursor: pointer; }
    .oa-checkbox-compact input[type="checkbox"] { width: 12px; height: 12px; margin: 0; }
    .oa-refresh-actions { display: flex; gap: 4px; }
    
    /* Settings panel - right aligned */
    .oa-settings-panel { position: absolute; top: 100%; right: 0; left: auto; background: #000; border: 1px solid #222; border-radius: 6px; margin-top: 4px; z-index: 101; max-height: 350px; overflow-y: auto; width: 240px; }
    .oa-settings-panel.hidden { display: none; }
    .oa-settings-content { padding: 10px; }
    .oa-settings-content h3 { margin: 0 0 10px; font-size: 12px; }
    .oa-settings-content h4 { margin: 10px 0 6px; font-size: 10px; color: #666; }
    .oa-form-group { margin-bottom: 8px; }
    .oa-form-group label { display: block; font-size: 9px; color: #666; margin-bottom: 3px; }
    .oa-form-group input, .oa-form-group select { width: 100%; background: #111; color: #fff; border: 1px solid #333; border-radius: 3px; padding: 6px; box-sizing: border-box; font-size: 10px; }
    .oa-symbol-list { max-height: 80px; overflow-y: auto; margin-bottom: 6px; }
    .oa-symbol-item { display: flex; justify-content: space-between; align-items: center; padding: 4px 6px; background: #111; border-radius: 3px; margin-bottom: 3px; font-size: 10px; }
    .oa-symbol-info { flex: 1; }
    .oa-symbol-actions { display: flex; gap: 4px; align-items: center; }

    /* Mode toggle switch */
    .oa-mode-toggle { position: relative; display: inline-block; width: 36px; height: 18px; }
    .oa-mode-switch { opacity: 0; width: 0; height: 0; }
    .oa-mode-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 18px; }
    .oa-mode-slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; }
    .oa-mode-switch:checked + .oa-mode-slider { background-color: #5c6bc0; }
    .oa-mode-switch:checked + .oa-mode-slider:before { transform: translateX(18px); }
    .oa-edit-symbol { background: transparent; border: none; cursor: pointer; font-size: 12px; padding: 2px; }
    .oa-remove-symbol { background: transparent; border: none; color: #ff5252; cursor: pointer; font-size: 12px; padding: 2px; }
    .oa-edit-form { background: #1a1a2e; padding: 8px; border-radius: 4px; margin-bottom: 8px; }
    .oa-edit-form.hidden { display: none; }
    .oa-edit-row { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
    .oa-edit-row input, .oa-edit-row select { flex: 1; min-width: 50px; background: #111; color: #fff; border: 1px solid #333; border-radius: 3px; padding: 4px; font-size: 9px; }
    .oa-add-symbol { display: flex; gap: 3px; flex-wrap: wrap; }
    .oa-add-symbol input, .oa-add-symbol select { flex: 1; min-width: 50px; background: #111; color: #fff; border: 1px solid #333; border-radius: 3px; padding: 4px; font-size: 9px; }
    .oa-btn { padding: 5px 10px; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; text-transform: uppercase; font-size: 9px; }
    .oa-btn.primary { background: #5c6bc0; color: #fff; }
    .oa-btn.success { background: #00c853; color: #fff; }
    .oa-btn.warning { background: #ffc107; color: #000; }
    .oa-btn.error { background: #ff5252; color: #fff; }
    .oa-btn.info { background: #29b6f6; color: #fff; }
    .oa-quick-row { display: flex; gap: 4px; align-items: center; }
    
    /* Loading animation */
    .oa-loading { position: relative; overflow: hidden; }
    .oa-loading::after { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent); animation: oa-shimmer 1s infinite; }
    .oa-light-theme .oa-loading::after { background: linear-gradient(90deg, transparent, rgba(0,0,0,0.1), transparent); }
    @keyframes oa-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
    
    /* Notifications */
    .openalgo-notification { position: fixed; bottom: 20px; right: 20px; padding: 10px 16px; border-radius: 6px; font-weight: 600; z-index: 10001; animation: slideIn 0.3s ease; font-size: 11px; }
    .openalgo-notification.success { background: #00c853; color: #fff; }
    .openalgo-notification.error { background: #ff5252; color: #fff; }
    .openalgo-notification.fadeOut { opacity: 0; transition: opacity 0.5s; }
    @keyframes slideIn { from { transform: translateX(100px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

    /* Orders Dropdown */
    .oa-orders-dropdown { position: absolute !important; top: 100% !important; right: 0 !important; left: auto !important; background: #000 !important; border: 1px solid #222 !important; border-radius: 6px !important; margin-top: 4px !important; z-index: 105 !important; width: 400px !important; box-shadow: 0 4px 20px rgba(0,0,0,0.5) !important; }
    .oa-orders-dropdown.hidden { display: none !important; }
    .oa-orders-header { display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 8px !important; border-bottom: 1px solid #222 !important; background: #111 !important; border-radius: 6px 6px 0 0 !important; }
    .oa-orders-title { font-size: 11px !important; font-weight: 700 !important; color: #fff !important; }
    .oa-tab-menu { display: flex !important; gap: 4px !important; }
    .oa-tab-btn { background: transparent !important; border: none !important; color: #888 !important; font-size: 10px !important; font-weight: 600 !important; cursor: pointer !important; padding: 4px 8px !important; border-radius: 4px !important; white-space: nowrap !important; }
    .oa-tab-btn:hover { color: #fff !important; background: rgba(255,255,255,0.1) !important; }
    .oa-tab-btn.active { background: #333 !important; color: #fff !important; }
    .oa-orders-filters { display: flex !important; gap: 4px !important; padding: 6px 8px !important; border-bottom: 1px solid #222 !important; }
    .oa-filter-btn { background: transparent !important; border: none !important; color: #666 !important; font-size: 10px !important; cursor: pointer !important; padding: 2px 6px !important; border-radius: 3px !important; }
    .oa-filter-btn.active { background: #333 !important; color: #fff !important; }
    .oa-orders-list { max-height: 300px !important; overflow-y: auto !important; padding: 0 !important; background: #000 !important; }
    .oa-order-item { padding: 8px !important; border-bottom: 1px solid #222 !important; font-size: 10px !important; background: transparent !important; }
    .oa-order-item:last-child { border-bottom: none !important; }
    .oa-order-row-top { display: flex !important; justify-content: space-between !important; margin-bottom: 4px !important; }
    .oa-order-symbol { font-weight: 700 !important; color: #fff !important; }
    .oa-order-tag { padding: 1px 4px !important; border-radius: 2px !important; font-size: 8px !important; font-weight: 600 !important; margin-left: 4px !important; }
    .oa-order-tag.buy { background: rgba(0, 200, 83, 0.2) !important; color: #00e676 !important; }
    .oa-order-tag.sell { background: rgba(255, 23, 68, 0.2) !important; color: #ff5252 !important; }
    .oa-order-status { font-size: 9px !important; color: #aaa !important; text-transform: uppercase !important; }
    .oa-order-status.complete { color: #00e676 !important; }
    .oa-order-status.rejected { color: #ff5252 !important; }
    .oa-order-status.cancelled { color: #ff9800 !important; }
    .oa-order-status.open { color: #ffc107 !important; }
    .oa-order-row-details { display: flex !important; justify-content: space-between !important; color: #888 !important; align-items: center !important; }
    .oa-order-actions { display: flex !important; gap: 6px !important; }
    .oa-order-action-btn { background: transparent !important; border: none !important; cursor: pointer !important; font-size: 12px !important; padding: 2px !important; color: #666 !important; }
    .oa-order-action-btn:hover { color: #fff !important; }
    .oa-order-action-btn.edit:hover { color: #29b6f6 !important; }
    .oa-order-action-btn.cancel:hover { color: #ff5252 !important; }
    .oa-order-action-btn.hover-only { opacity: 0 !important; transition: opacity 0.2s !important; }
    .oa-order-item:hover .oa-order-action-btn.hover-only { opacity: 1 !important; }
    .oa-orders-footer { padding: 8px !important; border-top: 1px solid #222 !important; display: flex !important; justify-content: flex-start !important; align-items: center !important; gap: 8px !important; background: #0a0a0a !important; border-radius: 0 0 6px 6px !important; }
    .oa-footer-btn { background: #222 !important; color: #ccc !important; border: 1px solid #333 !important; border-radius: 3px !important; padding: 4px 8px !important; font-size: 9px !important; cursor: pointer !important; }
    .oa-footer-btn:hover { background: #333 !important; color: #fff !important; }
    .oa-footer-stats { font-size: 9px !important; color: #888 !important; margin-left: 8px !important; }
    .oa-footer-pnl { font-size: 10px !important; font-weight: 600 !important; margin-left: auto !important; }
    .oa-empty-state { padding: 20px !important; text-align: center !important; color: #666 !important; font-size: 10px !important; }

    /* Tab Menu */
    .oa-tab-menu { display: flex !important; gap: 4px !important; }
    .oa-tab-btn { background: transparent !important; border: none !important; color: #666 !important; font-size: 11px !important; font-weight: 600 !important; cursor: pointer !important; padding: 4px 10px !important; border-radius: 4px !important; transition: all 0.2s !important; }
    .oa-tab-btn:hover { color: #aaa !important; }
    .oa-tab-btn.active { background: #333 !important; color: #fff !important; }
    .oa-tab-content { display: block !important; }
    .oa-tab-content.hidden { display: none !important; }

    /* Footer Stats */
    .oa-footer-pnl.profit { color: #00e676 !important; }
    .oa-footer-pnl.loss { color: #ff5252 !important; }

    /* Light theme overrides */
    .oa-light-theme .oa-orders-dropdown { background: #fff !important; border-color: #ddd !important; box-shadow: 0 4px 20px rgba(0,0,0,0.1) !important; }
    .oa-light-theme .oa-orders-header { background: #f5f5f5 !important; border-color: #ddd !important; }
    .oa-light-theme .oa-orders-title { color: #333 !important; }
    .oa-light-theme .oa-orders-filters { border-color: #ddd !important; }
    .oa-light-theme .oa-filter-btn { color: #888 !important; }
    .oa-light-theme .oa-filter-btn.active { background: #e0e0e0 !important; color: #333 !important; }
    .oa-light-theme .oa-orders-list { background: #fff !important; }
    .oa-light-theme .oa-order-item { border-color: #eee !important; background: transparent !important; }
    .oa-light-theme .oa-order-symbol { color: #333 !important; }
    .oa-light-theme .oa-order-row-details { color: #666 !important; }
    .oa-light-theme .oa-order-action-btn { color: #999 !important; }
    .oa-light-theme .oa-order-action-btn:hover { color: #333 !important; }
    .oa-light-theme .oa-orders-footer { background: #f5f5f5 !important; border-color: #ddd !important; }
    .oa-light-theme .oa-footer-btn { background: #fff !important; color: #333 !important; border-color: #ccc !important; }
    .oa-light-theme .oa-footer-btn:hover { background: #eee !important; }
    .oa-light-theme .oa-footer-stats { color: #666 !important; }
    .oa-light-theme .oa-tab-btn { color: #888 !important; }
    .oa-light-theme .oa-tab-btn:hover { color: #555 !important; }
    .oa-light-theme .oa-tab-btn.active { background: #e0e0e0 !important; color: #333 !important; }
    .oa-light-theme .oa-empty-state { color: #888 !important; }
  `;
  document.head.appendChild(style);
}

// ============ Order Management Functions ============

function toggleOrdersDropdown(show) {
  const dd = document.getElementById('oa-orders-dropdown');
  const btn = document.getElementById('oa-orders-btn');
  if (!dd) return;

  const isShow = show !== undefined ? show : dd.classList.contains('hidden');
  dd.classList.toggle('hidden', !isShow);
  btn?.classList.toggle('active', isShow);

  if (isShow) {
    // Hide other panels directly without calling their toggle functions
    const settingsPanel = document.getElementById('oa-settings-panel');
    if (settingsPanel) settingsPanel.classList.add('hidden');
    const refreshPanel = document.getElementById('oa-refresh-panel');
    if (refreshPanel) refreshPanel.classList.add('hidden');

    // Refresh orders when opening
    fetchOrders();
  }
}

// ============ Lot Size Cache Functions ============

// Parse option symbol to extract underlying and expiry
// Example: "NIFTY26DEC2424500CE" -> { underlying: "NIFTY", expiry: "26DEC24", strike: "24500", optionType: "CE" }
// Example: "BANKNIFTY26DEC2452000PE" -> { underlying: "BANKNIFTY", expiry: "26DEC24", strike: "52000", optionType: "PE" }
function parseOptionSymbol(symbol) {
  if (!symbol) return null;

  // Match pattern: UNDERLYING + DDMMMYY + STRIKE + CE/PE
  // e.g., NIFTY26DEC2424500CE, BANKNIFTY26DEC2452000PE
  const match = symbol.match(/^([A-Z]+)(\d{2}[A-Z]{3}\d{2})(\d+)(CE|PE)$/);
  if (match) {
    return {
      underlying: match[1],
      expiry: match[2],
      strike: match[3],
      optionType: match[4],
      isOption: true
    };
  }

  // For non-option symbols (equity/futures), return as-is
  return { underlying: symbol, expiry: '', isOption: false };
}

// Get lot size cache key for an option symbol
function getLotSizeCacheKey(underlying, expiry) {
  return `${underlying}:${expiry}`;
}

// Fetch lot size for a symbol from API
async function fetchLotSizeFromAPI(symbol, exchange) {
  const result = await apiCall('/api/v1/symbol', { symbol, exchange });
  if (result.status === 'success' && result.data) {
    return result.data.lotsize || 1;
  }
  return 1; // Default to 1 if fetch fails
}

// Get lot size for an order, using cache or fetching from API
async function getLotSizeForOrder(order) {
  const parsed = parseOptionSymbol(order.symbol);

  if (!parsed || !parsed.isOption) {
    // For non-option symbols, just fetch directly
    const cacheKey = `${order.symbol}:${order.exchange}`;
    if (lotSizeCache[cacheKey]) {
      return lotSizeCache[cacheKey];
    }
    const lotSize = await fetchLotSizeFromAPI(order.symbol, order.exchange);
    lotSizeCache[cacheKey] = lotSize;
    return lotSize;
  }

  // For options, cache by underlying:expiry
  const cacheKey = getLotSizeCacheKey(parsed.underlying, parsed.expiry);

  if (lotSizeCache[cacheKey]) {
    return lotSizeCache[cacheKey];
  }

  // Fetch from API for this specific symbol
  const lotSize = await fetchLotSizeFromAPI(order.symbol, order.exchange);
  lotSizeCache[cacheKey] = lotSize;
  return lotSize;
}

// Fetch lot sizes for all unique underlying:expiry combinations in orders
async function fetchLotSizesForOrders(orders) {
  // Group orders by underlying:expiry to avoid duplicate fetches
  const uniqueKeys = new Map(); // Map of cacheKey -> { symbol, exchange }

  for (const order of orders) {
    const parsed = parseOptionSymbol(order.symbol);

    if (!parsed) continue;

    let cacheKey;
    if (parsed.isOption) {
      cacheKey = getLotSizeCacheKey(parsed.underlying, parsed.expiry);
    } else {
      cacheKey = `${order.symbol}:${order.exchange}`;
    }

    // Skip if already in cache
    if (lotSizeCache[cacheKey]) continue;

    // Add to fetch list if not already queued
    if (!uniqueKeys.has(cacheKey)) {
      uniqueKeys.set(cacheKey, { symbol: order.symbol, exchange: order.exchange });
    }
  }

  // Fetch all missing lot sizes in parallel
  const fetchPromises = [];
  for (const [cacheKey, { symbol, exchange }] of uniqueKeys) {
    fetchPromises.push(
      fetchLotSizeFromAPI(symbol, exchange).then(lotSize => {
        lotSizeCache[cacheKey] = lotSize;
      })
    );
  }

  if (fetchPromises.length > 0) {
    await Promise.all(fetchPromises);
  }
}

// Get lot size from cache for an order (sync version, assumes cache is populated)
function getCachedLotSizeForOrder(order) {
  const parsed = parseOptionSymbol(order.symbol);

  if (!parsed) return state.lotSize || 1;

  let cacheKey;
  if (parsed.isOption) {
    cacheKey = getLotSizeCacheKey(parsed.underlying, parsed.expiry);
  } else {
    cacheKey = `${order.symbol}:${order.exchange}`;
  }

  return lotSizeCache[cacheKey] || state.lotSize || 1;
}

// Fetch LTPs for items (orders, trades, positions) via multiquotes API
async function fetchLTPsForItems(items) {
  if (!items || items.length === 0) return;

  // Build unique symbols list
  const uniqueSymbols = new Map();
  for (const item of items) {
    if (!item.symbol || !item.exchange) continue;
    const key = `${item.symbol}:${item.exchange}`;
    if (!uniqueSymbols.has(key)) {
      uniqueSymbols.set(key, { symbol: item.symbol, exchange: item.exchange });
    }
  }

  if (uniqueSymbols.size === 0) return;

  // Fetch via multiquotes API
  const symbols = Array.from(uniqueSymbols.values());
  const result = await apiCall('/api/v1/multiquotes', { symbols });

  if (result.status === 'success' && result.results) {
    // Update items with LTP
    for (const item of items) {
      const quote = result.results.find(r => r.symbol === item.symbol && r.exchange === item.exchange);
      if (quote && quote.data) {
        item.ltp = quote.data.ltp || 0;
      }
    }
  }
}

async function fetchOrders() {
  if (!settings.apiKey) return;

  state.ordersLoading = true;
  const list = document.getElementById('oa-orders-list');
  if (list) list.innerHTML = '<div class="oa-loading" style="height: 50px;"></div>';

  const result = await apiCall('/api/v1/orderbook', {});
  state.ordersLoading = false;

  if (result.status === 'success' && result.data && result.data.orders) {
    state.orders = result.data.orders;
    // Fetch lot sizes for all unique underlying:expiry combinations
    await fetchLotSizesForOrders(state.orders);
    // Fetch LTPs for all orders via multiquotes
    await fetchLTPsForItems(state.orders);
    renderOrders();
  } else {
    state.orders = [];
    if (list) list.innerHTML = `<div class="oa-empty-state">Failed to fetch orders</div>`;
  }
}

function renderOrders() {
  const list = document.getElementById('oa-orders-list');
  if (!list) return;

  if (state.orders.length === 0) {
    list.innerHTML = '<div class="oa-empty-state">No orders found</div>';
    return;
  }

  // Filter orders
  const filtered = state.orders.filter(o => {
    const s = o.order_status ? o.order_status.toLowerCase().replace(/_/g, ' ') : '';
    if (state.ordersFilter === 'open') {
      return ['open', 'trigger pending', 'validation pending', 'put order req received'].includes(s);
    } else if (state.ordersFilter === 'completed') {
      return ['complete', 'executed'].includes(s);
    } else if (state.ordersFilter === 'rejected') {
      return ['rejected'].includes(s);
    } else if (state.ordersFilter === 'cancelled') {
      return ['cancelled', 'canceled'].includes(s);
    }
    return true; // all
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="oa-empty-state">No orders in this category</div>';
    return;
  }

  // Sort by timestamp newly first (if available), else by orderid descending
  filtered.sort((a, b) => {
    // Try to parse timestamp 09-Dec-2024 09:44:09
    const tA = new Date(a.timestamp).getTime();
    const tB = new Date(b.timestamp).getTime();
    if (tA && tB) return tB - tA;
    return b.orderid.localeCompare(a.orderid);
  });

  list.innerHTML = filtered.map(o => {
    const isBuy = o.action === 'BUY';
    const statusClass = (o.order_status || 'open').toLowerCase().replace(/\s+/g, '_');
    // Map status to class (simple mapping)
    const finalStatusClass = ['complete', 'executed'].includes(statusClass) ? 'complete' :
      ['rejected'].includes(statusClass) ? 'rejected' :
        ['cancelled', 'canceled'].includes(statusClass) ? 'cancelled' : 'open';

    const canEdit = finalStatusClass === 'open';
    const canCancel = finalStatusClass === 'open';

    // Get lot size for this specific order from cache
    const orderLotSize = getCachedLotSizeForOrder(o);
    // Convert quantity to lots for display using order-specific lot size
    const qty = parseInt(o.quantity) || 0;
    const displayLots = orderLotSize > 0 ? Math.floor(qty / orderLotSize) : qty;

    // Extract time from timestamp using helper function
    const timeStr = extractTimeFromTimestamp(o.timestamp);

    return `
      <div class="oa-order-item" id="order-${o.orderid}" data-id="${o.orderid}" data-strategy="${o.strategy || 'Chrome'}" data-qty="${o.quantity}">
        <div class="oa-order-row-top">
          <span class="oa-order-symbol">${o.symbol}
            <span class="oa-order-tag ${isBuy ? 'buy' : 'sell'}">${o.action}</span>
            <span class="oa-order-tag">${o.pricetype}</span>
            <span class="oa-order-tag">${o.product}</span>
          </span>
          <span class="oa-order-status ${finalStatusClass}">${o.order_status}</span>
        </div>
        <div class="oa-order-row-details">
          <span>Lots: ${displayLots}${o.trigger_price > 0 ? ' • Trg: ' + o.trigger_price : ''} • Price: ${o.price} • LTP: ${(o.ltp || 0).toFixed(2)}</span>
          <div style="display:flex;align-items:center;gap:6px;">
            ${timeStr ? `<span style="font-size:9px;color:#888;">${timeStr}</span>` : ''}
            <div class="oa-order-actions">
              ${canEdit ? `<button class="oa-order-action-btn edit" title="Edit">✏️</button>` : ''}
              ${canCancel ? `<button class="oa-order-action-btn cancel" title="Cancel">✕</button>` : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Add listeners for actions
  list.querySelectorAll('.oa-order-action-btn.cancel').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.target.closest('.oa-order-item');
      cancelOrder(item.dataset.id, item.dataset.strategy);
    });
  });

  list.querySelectorAll('.oa-order-action-btn.edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.target.closest('.oa-order-item');
      enterEditMode(item.dataset.id);
    });
  });
}

function enterEditMode(orderId) {
  const item = document.getElementById(`order-${orderId}`);
  if (!item) return;

  const order = state.orders.find(o => o.orderid === orderId);
  if (!order) return;

  const isTrigger = ['SL', 'SL-M'].includes(order.pricetype);

  // Get lot size for this specific order from cache
  const orderLotSize = getCachedLotSizeForOrder(order);
  // Convert qty to lots for display using order-specific lot size
  const qty = parseInt(order.quantity) || 0;
  const displayLots = orderLotSize > 0 ? Math.floor(Math.abs(qty) / orderLotSize) : Math.abs(qty);

  item.innerHTML = `
    <div class="oa-order-row-top" style="margin-bottom: 8px;">
      <span class="oa-order-symbol">${order.symbol} <span style="font-size:9px;color:#666;">Editing...</span></span>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:6px;">
      <div style="width:55px;">
        <label style="font-size:8px;color:#888;display:block;margin-bottom:2px;">Lots</label>
        <input type="number" id="edit-lots-${orderId}" value="${displayLots}" min="1" class="oa-small-input" style="width:100%;padding:6px;">
      </div>
      ${isTrigger ? `
      <div style="width:75px;">
        <label style="font-size:8px;color:#888;display:block;margin-bottom:2px;">Trigger</label>
        <input type="number" id="edit-trg-${orderId}" value="${order.trigger_price || 0}" step="0.1" class="oa-small-input" style="width:100%;padding:6px;">
      </div>` : ''}
      <div style="width:75px;">
        <label style="font-size:8px;color:#888;display:block;margin-bottom:2px;">Price</label>
        <input type="number" id="edit-price-${orderId}" value="${order.price}" step="0.1" class="oa-small-input" style="width:100%;padding:6px;">
      </div>
    </div>
    <div style="display:flex;gap:6px;justify-content:flex-end;">
      <button class="oa-btn success" id="save-edit-${orderId}" style="padding:4px 12px;font-size:9px;">Save</button>
      <button class="oa-btn" id="cancel-edit-${orderId}" style="padding:4px 12px;font-size:9px;background:#333;color:#ccc;">Cancel</button>
    </div>
  `;

  document.getElementById(`save-edit-${orderId}`)?.addEventListener('click', () => saveEditOrder(orderId));
  document.getElementById(`cancel-edit-${orderId}`)?.addEventListener('click', () => renderOrders());
}

async function saveEditOrder(orderId) {
  const order = state.orders.find(o => o.orderid === orderId);
  if (!order) return;

  const lotsInput = document.getElementById(`edit-lots-${orderId}`);
  const priceInput = document.getElementById(`edit-price-${orderId}`);
  const trgInput = document.getElementById(`edit-trg-${orderId}`);

  // Get lot size for this specific order from cache
  const orderLotSize = getCachedLotSizeForOrder(order);
  // Convert lots to qty for API call using order-specific lot size
  const lotsValue = lotsInput ? parseInt(lotsInput.value) || 1 : 1;
  const newQty = lotsValue * orderLotSize;
  const newPrice = priceInput ? priceInput.value : order.price;
  const newTrg = trgInput ? trgInput.value : (order.trigger_price || 0);

  const btn = document.getElementById(`save-edit-${orderId}`);
  if (btn) { btn.textContent = '...'; btn.disabled = true; }

  const data = {
    strategy: order.strategy || 'Chrome',
    symbol: order.symbol,
    exchange: order.exchange,
    action: order.action,
    product: order.product,
    pricetype: order.pricetype,
    orderid: order.orderid,
    quantity: String(newQty),
    price: String(newPrice),
    trigger_price: String(newTrg),
    disclosed_quantity: "0" // Mandatory param
  };

  const result = await apiCall('/api/v1/modifyorder', data);

  if (result.status === 'success') {
    showNotification(`Order modified ${result.orderid || ''}`, 'success');
    fetchOrders(); // Refresh list
  } else {
    showNotification(`Modify failed: ${result.message || 'Unknown'}`, 'error');
    if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
  }
}

async function cancelOrder(orderId, strategy) {
  // Direct call, no confirmation as requested
  const result = await apiCall('/api/v1/cancelorder', {
    strategy: strategy || 'Chrome',
    orderid: orderId
  });

  if (result.status === 'success') {
    showNotification('Order cancelled', 'success');
    fetchOrders();
  } else {
    showNotification(`Cancel failed: ${result.message}`, 'error');
  }
}

async function cancelAllOrders() {
  const btn = document.getElementById('oa-cancel-all-btn');
  if (btn) btn.textContent = 'Cancelling...';

  const result = await apiCall('/api/v1/cancelallorder', {
    strategy: 'Chrome' // Assuming global cancel for this strategy or generally
  });

  if (result.status === 'success') {
    const count = result.canceled_orders ? result.canceled_orders.length : 0;
    showNotification(`Cancelled ${count} orders`, 'success');
    fetchOrders();
  } else {
    showNotification(`Cancel all failed: ${result.message}`, 'error');
  }

  if (btn) btn.textContent = 'Cancel All';
}

// ============ Tab Switching ============

function switchBookTab(tabName) {
  state.activeBookTab = tabName;

  // Update tab buttons
  document.querySelectorAll('.oa-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update tab content visibility
  document.querySelectorAll('.oa-tab-content').forEach(content => {
    content.classList.add('hidden');
  });
  const activeContent = document.getElementById(`oa-tab-${tabName}`);
  if (activeContent) activeContent.classList.remove('hidden');

  // Fetch data for the active tab
  if (tabName === 'orders') {
    fetchOrders();
  } else if (tabName === 'tradebook') {
    fetchTradebook();
  } else if (tabName === 'positions') {
    fetchPositions();
  }
}

// ============ Tradebook Functions ============

async function fetchTradebook() {
  if (!settings.apiKey) return;

  state.tradesLoading = true;
  const list = document.getElementById('oa-tradebook-list');
  if (list) list.innerHTML = '<div class="oa-loading" style="height: 50px;"></div>';

  const result = await apiCall('/api/v1/tradebook', {});
  state.tradesLoading = false;

  if (result.status === 'success' && result.data) {
    state.trades = result.data;
    // Fetch lot sizes for trades
    await fetchLotSizesForOrders(state.trades);
    // Fetch LTPs for all trades via multiquotes
    await fetchLTPsForItems(state.trades);
    renderTradebook();
  } else {
    state.trades = [];
    if (list) list.innerHTML = '<div class="oa-empty-state">Failed to fetch tradebook</div>';
  }
}

function renderTradebook() {
  const list = document.getElementById('oa-tradebook-list');
  if (!list) return;

  if (state.trades.length === 0) {
    list.innerHTML = '<div class="oa-empty-state">No trades found</div>';
    updateTradebookStats();
    return;
  }

  // Sort by timestamp (recent first)
  const sorted = [...state.trades].sort((a, b) => {
    const tA = new Date(a.timestamp).getTime();
    const tB = new Date(b.timestamp).getTime();
    if (tA && tB) return tB - tA;
    return 0;
  });

  list.innerHTML = sorted.map(t => {
    const isBuy = t.action === 'BUY';
    const orderLotSize = getCachedLotSizeForOrder(t);
    const qty = parseInt(t.quantity) || 0;
    const displayLots = orderLotSize > 0 ? Math.floor(qty / orderLotSize) : qty;

    // Extract time from timestamp using helper function
    const timeStr = extractTimeFromTimestamp(t.timestamp);

    return `
      <div class="oa-order-item">
        <div class="oa-order-row-top">
          <span class="oa-order-symbol">${t.symbol}
            <span class="oa-order-tag ${isBuy ? 'buy' : 'sell'}">${t.action}</span>
            <span class="oa-order-tag">${t.product}</span>
          </span>
          <span style="font-size:9px;color:#888;">${timeStr}</span>
        </div>
        <div class="oa-order-row-details">
          <span>Lots: ${displayLots} • Avg: ${t.average_price} • LTP: ${(t.ltp || 0).toFixed(2)} • Value: ${t.trade_value}</span>
        </div>
      </div>
    `;
  }).join('');

  updateTradebookStats();
}

function updateTradebookStats() {
  const statsEl = document.getElementById('oa-tradebook-stats');
  if (!statsEl) return;

  const total = state.trades.length;
  const buys = state.trades.filter(t => t.action === 'BUY').length;
  const sells = state.trades.filter(t => t.action === 'SELL').length;

  statsEl.textContent = `Total: ${total} • Buy: ${buys} • Sell: ${sells}`;
}

// ============ Positions Functions ============

async function fetchPositions() {
  if (!settings.apiKey) return;

  state.positionsLoading = true;
  const list = document.getElementById('oa-positions-list');
  if (list) list.innerHTML = '<div class="oa-loading" style="height: 50px;"></div>';

  const result = await apiCall('/api/v1/positionbook', {});
  state.positionsLoading = false;

  if (result.status === 'success' && result.data) {
    state.positions = result.data;
    // Fetch lot sizes for positions
    await fetchLotSizesForOrders(state.positions);
    // LTP is already available in the position response, no need to call multiquotes
    renderPositions();
  } else {
    state.positions = [];
    if (list) list.innerHTML = '<div class="oa-empty-state">Failed to fetch positions</div>';
  }
}

function renderPositions() {
  const list = document.getElementById('oa-positions-list');
  if (!list) return;

  // Filter positions based on state.positionsFilter (open/closed)
  const filtered = state.positions.filter(p => {
    const qty = parseInt(p.quantity) || 0;
    if (state.positionsFilter === 'open') return qty !== 0;
    if (state.positionsFilter === 'closed') return qty === 0;
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = `<div class="oa-empty-state">No ${state.positionsFilter || 'open'} positions found</div>`;
    updatePositionsStats();
    return;
  }

  list.innerHTML = filtered.map(p => {
    const qty = parseInt(p.quantity) || 0;
    const isOpen = qty !== 0;
    const isLong = qty > 0;
    const orderLotSize = getCachedLotSizeForOrder(p);
    const displayLots = orderLotSize > 0 ? Math.floor(Math.abs(qty) / orderLotSize) : Math.abs(qty);

    // Use pnl field from API response
    const pnl = parseFloat(p.pnl) || 0;
    const unrealizedPnl = parseFloat(p.unrealized_pnl) || 0;
    const ltp = parseFloat(p.ltp) || 0;
    const avgPrice = parseFloat(p.average_price) || 0;
    const pnlClass = pnl >= 0 ? 'profit' : 'loss';
    const pnlSign = pnl >= 0 ? '+' : '';

    // Show unrealized PnL in braces if present
    let pnlDisplay = `${pnlSign}${pnl.toFixed(2)}`;
    if (unrealizedPnl !== 0) {
      const unrealizedSign = unrealizedPnl >= 0 ? '+' : '';
      pnlDisplay += ` (${unrealizedSign}${unrealizedPnl.toFixed(2)} unrealized)`;
    }

    // Tag for position state
    let posTag = '';
    let posTagClass = '';
    if (qty > 0) {
      posTag = 'LONG';
      posTagClass = 'buy';
    } else if (qty < 0) {
      posTag = 'SHORT';
      posTagClass = 'sell';
    } else {
      posTag = 'FLAT';
      posTagClass = '';
    }

    return `
      <div class="oa-order-item" data-symbol="${p.symbol}" data-exchange="${p.exchange}" data-product="${p.product}" data-qty="${qty}">
        <div class="oa-order-row-top">
          <span class="oa-order-symbol">${p.symbol}
            <span class="oa-order-tag ${posTagClass}">${posTag}</span>
            <span class="oa-order-tag">${p.product}</span>
          </span>
          <span class="oa-footer-pnl ${pnlClass}">${pnlDisplay}</span>
        </div>
        <div class="oa-order-row-details">
          <span>Lots: ${isLong ? '+' : (qty < 0 ? '-' : '')}${displayLots} • Avg: ${avgPrice.toFixed(2)} • LTP: ${ltp.toFixed(2)}</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:9px;color:#888;">${p.exchange}</span>
            ${isOpen ? `<button class="oa-order-action-btn close hover-only" title="Square Off" data-symbol="${p.symbol}" data-exchange="${p.exchange}" data-product="${p.product}">✖</button>` : ''}
            <button class="oa-order-action-btn edit hover-only" title="Edit Position" data-symbol="${p.symbol}" data-exchange="${p.exchange}" data-product="${p.product}">✏️</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Add edit listeners for positions
  list.querySelectorAll('.oa-order-action-btn.edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.target.closest('.oa-order-item');
      enterPositionEditMode(item);
    });
  });

  // Add close/square-off listeners for open positions
  list.querySelectorAll('.oa-order-action-btn.close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      squareOffPosition(btn.dataset.symbol, btn.dataset.exchange, btn.dataset.product);
    });
  });

  updatePositionsStats();
}

function enterPositionEditMode(item) {
  const symbol = item.dataset.symbol;
  const exchange = item.dataset.exchange;
  const product = item.dataset.product;
  const qty = parseInt(item.dataset.qty) || 0;

  const position = state.positions.find(p => p.symbol === symbol && p.exchange === exchange);
  if (!position) return;

  const orderLotSize = getCachedLotSizeForOrder(position);
  const currentLots = orderLotSize > 0 ? Math.floor(Math.abs(qty) / orderLotSize) : Math.abs(qty);
  const isLong = qty > 0;
  const isShort = qty < 0;
  const isFlat = qty === 0;

  // For flat positions, default to long direction
  const currentSign = isLong ? '+' : (isShort ? '-' : '+');
  const positionLabel = isLong ? 'LONG' : (isShort ? 'SHORT' : 'FLAT');
  const positionColor = isLong ? '#00c853' : (isShort ? '#ff5252' : '#888');

  // Initial target = current with sign (negative for short)
  const initialTargetLots = isShort ? -currentLots : currentLots;
  const initialPctSign = isShort ? '-' : '+';

  // Generate unique ID for this edit session to properly handle cleanup
  const editId = `pos-edit-${Date.now()}`;
  item.dataset.editId = editId;

  item.innerHTML = `
    <style>
      .oa-pos-edit-row1 { display: flex !important; justify-content: space-between !important; align-items: center !important; margin-bottom: 8px !important; }
      .oa-pos-edit-row2 { display: flex !important; justify-content: space-between !important; align-items: center !important; gap: 8px !important; }
      .oa-pos-current { font-size: 11px !important; font-weight: 600 !important; }
      .oa-pos-target-group { display: flex !important; align-items: center !important; gap: 6px !important; }
      .oa-pos-target-label { font-size: 10px !important; color: #888 !important; white-space: nowrap !important; }
      .oa-pos-target-input { 
        width: 60px !important; padding: 4px 6px !important; border: 1px solid #444 !important; 
        border-radius: 4px !important; background: #1a1a1a !important; color: #fff !important; 
        font-size: 11px !important; text-align: center !important;
      }

      .oa-pos-pct-trigger {
        padding: 4px 8px !important; font-size: 10px !important; border: 1px solid #444 !important;
        border-radius: 4px !important; background: #222 !important; color: #aaa !important; cursor: pointer !important;
      }
      .oa-pos-pct-trigger:hover { background: #333 !important; color: #fff !important; }
      .oa-pos-pct-popup {
        position: absolute !important; top: 100% !important; left: 0 !important; z-index: 100 !important;
        background: #1a1a1a !important; border: 1px solid #444 !important; border-radius: 6px !important;
        padding: 8px !important; margin-top: 4px !important; min-width: 220px !important;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4) !important; display: none !important;
      }
      .oa-pos-pct-popup.show { display: block !important; }
      .oa-pos-toggle-row { display: flex !important; gap: 4px !important; margin-bottom: 6px !important; }
      .oa-pos-toggle-btn { 
        flex: 1 !important; padding: 4px 8px !important; font-size: 9px !important; border: 1px solid #444 !important; 
        border-radius: 4px !important; background: #222 !important; color: #888 !important; cursor: pointer !important;
        text-align: center !important;
      }
      .oa-pos-toggle-btn.active { background: #333 !important; color: #fff !important; border-color: #666 !important; }
      .oa-pos-pct-row { display: flex !important; gap: 4px !important; }
      .oa-pos-pct-btn { 
        flex: 1 !important; padding: 4px 0 !important; font-size: 9px !important; border: 1px solid #444 !important; 
        border-radius: 4px !important; background: #222 !important; color: #aaa !important; 
        cursor: pointer !important; text-align: center !important;
      }
      .oa-pos-pct-btn:hover { background: #444 !important; color: #fff !important; }
      .oa-pos-custom-btn {
        flex: 1 !important; padding: 4px 0 !important; font-size: 9px !important; border: 1px solid #444 !important;
        border-radius: 4px !important; background: #222 !important; color: #aaa !important;
        cursor: pointer !important; text-align: center !important; position: relative !important;
      }
      .oa-pos-custom-btn:hover { background: #444 !important; color: #fff !important; }
      .oa-pos-custom-btn.editing {
        padding: 0 !important;
      }
      .oa-pos-custom-input { 
        width: 100% !important; padding: 4px 2px !important; font-size: 9px !important; 
        border: none !important; border-radius: 4px !important; 
        background: transparent !important; color: #fff !important; text-align: center !important;
        outline: none !important;
      }
      .oa-pos-buttons { display: flex !important; gap: 6px !important; margin-left: auto !important; }
      .oa-pos-action-btn { 
        padding: 5px 10px !important; font-size: 10px !important; font-weight: 600 !important; 
        border: none !important; border-radius: 4px !important; cursor: pointer !important;
      }
      .oa-pos-action-btn.buy { background: #00c853 !important; color: #fff !important; }
      .oa-pos-action-btn.sell { background: #ff5252 !important; color: #fff !important; }
      .oa-pos-action-btn.neutral { background: #555 !important; color: #fff !important; }
      .oa-pos-cancel-btn { 
        padding: 5px 10px !important; font-size: 10px !important; background: #333 !important; 
        color: #ccc !important; border: none !important; border-radius: 4px !important; cursor: pointer !important;
      }
      .oa-light-theme .oa-pos-target-input { background: #f5f5f5 !important; color: #222 !important; border-color: #ddd !important; }
      .oa-light-theme .oa-pos-pct-trigger { background: #e0e0e0 !important; color: #666 !important; border-color: #ccc !important; }
      .oa-light-theme .oa-pos-pct-popup { background: #fff !important; border-color: #ddd !important; }
      .oa-light-theme .oa-pos-toggle-btn { background: #e0e0e0 !important; color: #666 !important; border-color: #ccc !important; }
      .oa-light-theme .oa-pos-toggle-btn.active { background: #d0d0d0 !important; color: #222 !important; }
      .oa-light-theme .oa-pos-pct-btn { background: #e0e0e0 !important; color: #666 !important; border-color: #ccc !important; }
      .oa-light-theme .oa-pos-pct-btn:hover { background: #d0d0d0 !important; color: #222 !important; }
      .oa-light-theme .oa-pos-custom-btn { background: #e0e0e0 !important; color: #666 !important; border-color: #ccc !important; }
      .oa-light-theme .oa-pos-custom-input { color: #222 !important; }
    </style>
    <div class="oa-pos-edit-row1">
      <span class="oa-order-symbol">${symbol} <span style="font-size:9px;color:#666;">Editing...</span></span>
      <span class="oa-pos-current">Current: <span style="color:${positionColor};">${positionLabel}</span> (${currentSign}${currentLots} lots)</span>
    </div>
    <div class="oa-pos-edit-row2">
      <div class="oa-pos-target-group">
        <span class="oa-pos-target-label">Target:</span>
        <input type="number" id="edit-pos-lots-${editId}" value="${initialTargetLots}" class="oa-pos-target-input">
        <div style="position:relative;">
          <button class="oa-pos-pct-trigger" id="pos-pct-trigger-${editId}">%</button>
          <div class="oa-pos-pct-popup" id="pos-pct-popup-${editId}">
            <div class="oa-pos-toggle-row">
              <button class="oa-pos-toggle-btn active" id="pos-mode-add-${editId}">Add</button>
              <button class="oa-pos-toggle-btn" id="pos-mode-exit-${editId}">Exit</button>
            </div>
            <div class="oa-pos-pct-row" id="pos-pct-buttons-${editId}">
              <button class="oa-pos-pct-btn" data-pct="25">${initialPctSign}25%</button>
              <button class="oa-pos-pct-btn" data-pct="50">${initialPctSign}50%</button>
              <button class="oa-pos-pct-btn" data-pct="75">${initialPctSign}75%</button>
              <button class="oa-pos-pct-btn" data-pct="100">${initialPctSign}100%</button>
              <button class="oa-pos-custom-btn" id="pos-custom-btn-${editId}">✏️</button>
            </div>
          </div>
        </div>
      </div>
      <div class="oa-pos-buttons">
        <button class="oa-pos-action-btn neutral" id="save-pos-edit-${editId}">No Change</button>
        <button class="oa-pos-cancel-btn" id="cancel-pos-edit-${editId}">Cancel</button>
      </div>
    </div>
  `;

  // Setup event handlers
  setupPositionEditHandlers(item, editId, symbol, exchange, product, qty, orderLotSize, currentLots, isLong, isShort);
}

// Helper function to set up position edit event handlers
function setupPositionEditHandlers(item, editId, symbol, exchange, product, qty, orderLotSize, currentLots, isLong, isShort) {
  const lotsInput = document.getElementById(`edit-pos-lots-${editId}`);
  const pctTrigger = document.getElementById(`pos-pct-trigger-${editId}`);
  const pctPopup = document.getElementById(`pos-pct-popup-${editId}`);
  const addBtn = document.getElementById(`pos-mode-add-${editId}`);
  const exitBtn = document.getElementById(`pos-mode-exit-${editId}`);
  const pctContainer = document.getElementById(`pos-pct-buttons-${editId}`);
  const customBtn = document.getElementById(`pos-custom-btn-${editId}`);
  const actionBtn = document.getElementById(`save-pos-edit-${editId}`);
  const cancelBtn = document.getElementById(`cancel-pos-edit-${editId}`);

  if (!lotsInput || !actionBtn) return; // Guard against missing elements

  let editMode = 'add'; // 'add' or 'exit'
  let customPctDebounceTimer = null;
  let isCustomEditing = false;

  // Toggle popup visibility
  pctTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    pctPopup.classList.toggle('show');
  });

  // Close popup when clicking outside (use capture to ensure cleanup)
  function handleClickOutside(e) {
    if (pctPopup && !pctPopup.contains(e.target) && e.target !== pctTrigger) {
      pctPopup.classList.remove('show');
    }
  }
  document.addEventListener('click', handleClickOutside);

  // Store cleanup function on item for removal when re-entering edit
  item._cleanupEditHandlers = () => {
    document.removeEventListener('click', handleClickOutside);
    if (customPctDebounceTimer) clearTimeout(customPctDebounceTimer);
  };

  // Update button labels based on mode
  function updatePctButtonLabels() {
    const pctBtns = pctContainer.querySelectorAll('.oa-pos-pct-btn');
    const sign = editMode === 'add' ? (isShort ? '-' : '+') : (isShort ? '+' : '-');
    pctBtns.forEach(btn => {
      const pct = btn.dataset.pct;
      if (pct) {
        btn.textContent = `${sign}${pct}%`;
      }
    });
    // Update custom button text if not editing
    if (!isCustomEditing) {
      customBtn.innerHTML = '✏️';
    }
  }

  // Calculate and update action button
  function updateActionButton() {
    // Target value is signed (negative for short position target)
    const targetSignedLots = parseInt(lotsInput.value) || 0;

    // Current position in lots (signed)
    const currentSignedLots = isLong ? currentLots : (isShort ? -currentLots : 0);

    // Calculate change in LOTS
    const changeLots = targetSignedLots - currentSignedLots;

    if (changeLots === 0) {
      actionBtn.className = 'oa-pos-action-btn neutral';
      actionBtn.textContent = 'No Change';
      actionBtn.dataset.action = 'none';
    } else if (changeLots > 0) {
      actionBtn.className = 'oa-pos-action-btn buy';
      actionBtn.textContent = `BUY +${changeLots} Lots`;
      actionBtn.dataset.action = 'BUY';
    } else {
      actionBtn.className = 'oa-pos-action-btn sell';
      actionBtn.textContent = `SELL ${changeLots} Lots`;
      actionBtn.dataset.action = 'SELL';
    }
  }

  // Update target lots based on percentage
  function applyPercentage(pct, closePopup = true) {
    const calculated = Math.ceil(currentLots * pct / 100);
    const currentSignedLots = isShort ? -currentLots : currentLots;

    if (editMode === 'add') {
      // Add: increase position magnitude in same direction
      const newTarget = isShort ? -(currentLots + calculated) : (currentLots + calculated);
      lotsInput.value = newTarget;
    } else {
      // Exit: reduce position magnitude
      const reduced = Math.max(0, currentLots - calculated);
      const newTarget = isShort ? -reduced : reduced;
      lotsInput.value = newTarget;
    }

    updateActionButton();
    if (closePopup) pctPopup.classList.remove('show');
  }

  // Mode toggle handlers
  addBtn.addEventListener('click', () => {
    editMode = 'add';
    addBtn.classList.add('active');
    exitBtn.classList.remove('active');
    updatePctButtonLabels();
    // Reset to current signed position
    lotsInput.value = isShort ? -currentLots : currentLots;
    updateActionButton();
  });

  exitBtn.addEventListener('click', () => {
    editMode = 'exit';
    exitBtn.classList.add('active');
    addBtn.classList.remove('active');
    updatePctButtonLabels();
    // Reset to current signed position
    lotsInput.value = isShort ? -currentLots : currentLots;
    updateActionButton();
  });

  // Percentage button handlers
  pctContainer.querySelectorAll('.oa-pos-pct-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pct = parseInt(btn.dataset.pct);
      if (pct) {
        applyPercentage(pct);
      }
    });
  });

  // Custom percentage button - show input on click
  customBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isCustomEditing) return;

    isCustomEditing = true;
    const sign = editMode === 'add' ? (isShort ? '-' : '+') : (isShort ? '+' : '-');
    customBtn.classList.add('editing');
    customBtn.innerHTML = `<input type="number" id="pos-custom-input-${editId}" class="oa-pos-custom-input" placeholder="${sign}%" min="1" max="500" autofocus>`;

    const customInput = document.getElementById(`pos-custom-input-${editId}`);
    customInput.focus();

    // Auto-calculate on input with 100ms debounce
    customInput.addEventListener('input', () => {
      clearTimeout(customPctDebounceTimer);
      customPctDebounceTimer = setTimeout(() => {
        const pct = parseInt(customInput.value) || 0;
        if (pct > 0) {
          applyPercentage(pct, false); // Don't close popup while typing
        }
      }, 100);
    });

    // Apply on Enter
    customInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const pct = parseInt(customInput.value) || 0;
        if (pct > 0) {
          applyPercentage(pct, true);
          isCustomEditing = false;
          customBtn.classList.remove('editing');
          customBtn.innerHTML = `${sign}${pct}%`;
        }
      }
    });

    // Reset on blur
    customInput.addEventListener('blur', () => {
      const pct = parseInt(customInput.value) || 0;
      isCustomEditing = false;
      customBtn.classList.remove('editing');
      if (pct > 0) {
        const sign = editMode === 'add' ? (isShort ? '-' : '+') : (isShort ? '+' : '-');
        customBtn.innerHTML = `${sign}${pct}%`;
      } else {
        customBtn.innerHTML = '✏️';
      }
    });
  });

  // Manual input handler
  lotsInput.addEventListener('input', updateActionButton);

  // Save handler
  actionBtn.addEventListener('click', () => {
    if (actionBtn.dataset.action === 'none') {
      if (item._cleanupEditHandlers) item._cleanupEditHandlers();
      renderPositions();
      return;
    }
    if (item._cleanupEditHandlers) item._cleanupEditHandlers();
    resizePosition(symbol, exchange, product, qty, orderLotSize, editId);
  });

  // Cancel handler
  cancelBtn.addEventListener('click', () => {
    if (item._cleanupEditHandlers) item._cleanupEditHandlers();
    renderPositions();
  });

  // Initialize
  updatePctButtonLabels();
  updateActionButton();
}

async function resizePosition(symbol, exchange, product, currentQty, lotSize, editId) {
  const lotsInput = document.getElementById(`edit-pos-lots-${editId}`);
  if (!lotsInput) return;

  // Target is now a signed value (negative for short position target)
  const targetSignedLots = parseInt(lotsInput.value) || 0;

  // Calculate target quantity with proper sign
  const targetQty = targetSignedLots * lotSize;

  // Determine action based on current position direction
  const isLong = currentQty > 0;
  const isShort = currentQty < 0;

  // Update button to show loading state
  const btn = document.getElementById(`save-pos-edit-${editId}`);
  const originalText = btn ? btn.textContent : 'Resize';
  if (btn) { btn.textContent = 'Placing...'; btn.disabled = true; }

  const result = await apiCall('/api/v1/placesmartorder', {
    strategy: 'Chrome',
    symbol: symbol,
    exchange: exchange,
    action: isLong ? 'BUY' : (isShort ? 'SELL' : 'BUY'), // Keep same direction for reference
    product: product,
    pricetype: 'MARKET',
    quantity: String(Math.abs(targetQty)), // Quantity must be positive
    price: '0',
    trigger_price: '0',
    position_size: String(targetQty)
  });

  if (result.status === 'success') {
    showNotification(`Position resized to ${targetSignedLots} lots`, 'success');
    renderPositions(); // Just re-render, no API refetch
  } else {
    showNotification(`Resize failed: ${result.message}`, 'error');
    if (btn) { btn.textContent = originalText; btn.disabled = false; }
  }
}

function updatePositionsStats() {
  const statsEl = document.getElementById('oa-positions-stats');
  const pnlEl = document.getElementById('oa-positions-pnl');
  if (!statsEl) return;

  const openPositions = state.positions.filter(p => parseInt(p.quantity) !== 0);
  const longs = openPositions.filter(p => parseInt(p.quantity) > 0).length;
  const shorts = openPositions.filter(p => parseInt(p.quantity) < 0).length;

  statsEl.textContent = `Open: ${openPositions.length} (L${longs} S${shorts})`;

  // Calculate total PnL from pnl field of each position
  if (pnlEl) {
    let totalPnl = 0;
    state.positions.forEach(p => {
      totalPnl += parseFloat(p.pnl) || 0;
    });

    const pnlClass = totalPnl >= 0 ? 'profit' : 'loss';
    const pnlSign = totalPnl >= 0 ? '+' : '';
    pnlEl.textContent = `Total: ${pnlSign}${totalPnl.toFixed(2)}`;
    pnlEl.className = `oa-footer-pnl ${pnlClass}`;
  }
}

async function closeAllPositions() {
  const btn = document.getElementById('oa-close-all-btn');
  if (btn) btn.textContent = 'Closing...';

  const result = await apiCall('/api/v1/closeposition', {
    strategy: 'Chrome'
  });

  if (result.status === 'success') {
    showNotification('All positions squared off', 'success');
    fetchPositions();
  } else {
    showNotification(`Close failed: ${result.message}`, 'error');
  }

  if (btn) btn.textContent = 'Close All';
}

// Square off a single position instantly (set position to 0)
async function squareOffPosition(symbol, exchange, product) {
  // Find the position to get current qty for display
  const position = state.positions.find(p => p.symbol === symbol && p.exchange === exchange && p.product === product);
  if (!position) {
    showNotification('Position not found', 'error');
    return;
  }

  const qty = parseInt(position.quantity) || 0;
  if (qty === 0) {
    showNotification('Position already closed', 'info');
    return;
  }

  // Determine action based on current position (need opposite to close)
  const action = qty > 0 ? 'SELL' : 'BUY';

  const result = await apiCall('/api/v1/placesmartorder', {
    strategy: 'Chrome',
    symbol: symbol,
    exchange: exchange,
    action: action,
    product: product,
    pricetype: 'MARKET',
    quantity: '0',
    price: '0',
    trigger_price: '0',
    position_size: '0'
  });

  if (result.status === 'success') {
    showNotification(`${symbol} position squared off`, 'success');
    // Update local state to reflect closed position
    if (position) position.quantity = 0;
    renderPositions();
  } else {
    showNotification(`Square off failed: ${result.message}`, 'error');
  }
}

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'injectButtons') {
    // Only re-initialize if not already done and no existing UI
    if (!isInitialized && !document.getElementById('openalgo-controls')) {
      init();
    }
    sendResponse({ success: true });
  }
  return true;
});
