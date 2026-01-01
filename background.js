// Background Service Worker for Live Data Polling
// Chrome extensions have security restrictions preventing WebSocket connections to localhost
// Using HTTP polling as a workaround for live market data

let apiKey = '';
let hostUrl = 'http://127.0.0.1:5001';
let pollInterval = null;
let isPolling = false;
const POLL_INTERVAL_MS = 500; // Poll every 500ms for live data

// Track subscriptions: { "symbol|exchange": true, ... }
let subscriptions = {};
let lastQuotes = {}; // Cache last quotes to avoid sending duplicates

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[OpenAlgo BG] Message received:', request.action);
  
  if (request.action === 'ws_connect') {
    apiKey = request.apiKey || apiKey;
    hostUrl = request.hostUrl || hostUrl;
    console.log('[OpenAlgo BG] Starting live data polling. Host:', hostUrl, 'API Key:', apiKey ? '***' : 'MISSING');
    startPolling();
    sendResponse({ status: 'connecting' });
  } else if (request.action === 'ws_send') {
    // Handle subscribe/unsubscribe messages
    if (request.data && request.data.action === 'subscribe') {
      const key = `${request.data.symbol}|${request.data.exchange}`;
      subscriptions[key] = true;
      console.log('[OpenAlgo BG] Subscribed to:', key);
      sendResponse({ status: 'sent' });
    } else if (request.data && request.data.action === 'unsubscribe') {
      const key = `${request.data.symbol}|${request.data.exchange}`;
      delete subscriptions[key];
      console.log('[OpenAlgo BG] Unsubscribed from:', key);
      sendResponse({ status: 'sent' });
    } else {
      sendResponse({ status: 'sent' });
    }
  } else if (request.action === 'ws_disconnect') {
    stopPolling();
    subscriptions = {};
    sendResponse({ status: 'disconnected' });
  } else if (request.action === 'ws_status') {
    sendResponse({ 
      status: isPolling ? 'connected' : 'disconnected',
      isPolling: isPolling,
      subscriptions: Object.keys(subscriptions)
    });
  }
});

function startPolling() {
  if (isPolling) {
    console.log('[OpenAlgo BG] Polling already started');
    return;
  }

  if (!apiKey) {
    console.warn('[OpenAlgo BG] Missing API key, cannot start polling');
    return;
  }

  isPolling = true;
  console.log('[OpenAlgo BG] Starting polling');
  
  // Notify tabs that connection is established
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { action: 'ws_connected' }).catch(() => {});
    });
  });

  // Start polling loop
  pollInterval = setInterval(pollMarketData, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  isPolling = false;
  console.log('[OpenAlgo BG] Polling stopped');
}

async function pollMarketData() {
  if (!isPolling || Object.keys(subscriptions).length === 0) {
    return;
  }

  try {
    // Get all subscribed symbols
    const symbols = Object.keys(subscriptions).map(key => {
      const [symbol, exchange] = key.split('|');
      return { symbol, exchange };
    });

    // Fetch quotes for all subscribed symbols
    for (const { symbol, exchange } of symbols) {
      try {
        const response = await fetch(`${hostUrl}/api/v1/quotes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apikey: apiKey,
            symbol: symbol,
            exchange: exchange
          })
        });

        if (!response.ok) {
          console.warn(`[OpenAlgo BG] Quote fetch failed for ${symbol}: ${response.status}`);
          continue;
        }

        const data = await response.json();
        
        // Extract LTP from response
        if (data.data && data.data.ltp) {
          const key = `${symbol}|${exchange}`;
          const lastQuote = lastQuotes[key];
          
          // Only send if price changed
          if (!lastQuote || lastQuote !== data.data.ltp) {
            lastQuotes[key] = data.data.ltp;
            
            // Broadcast to all tabs
            const marketData = {
              type: 'market_data',
              data: {
                symbol: symbol,
                exchange: exchange,
                ltp: data.data.ltp,
                bid: data.data.bid || data.data.ltp,
                ask: data.data.ask || data.data.ltp,
                open: data.data.open,
                high: data.data.high,
                low: data.data.low,
                volume: data.data.volume,
                oi: data.data.oi
              }
            };
            
            chrome.tabs.query({}, (tabs) => {
              tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, { action: 'ws_message', data: marketData }).catch(() => {});
              });
            });
          }
        }
      } catch (error) {
        console.warn(`[OpenAlgo BG] Error polling ${symbol}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[OpenAlgo BG] Polling error:', error);
  }
}

// Clean up on extension unload
chrome.runtime.onSuspend.addListener(() => {
  stopPolling();
});
