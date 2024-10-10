const fs = require('fs');
const WebSocket = require('ws');
const axios = require('axios');

function loadConfig() {
  const config = {};
  const data = fs.readFileSync('data.txt', 'utf-8');
  data.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) {
      config[key.trim()] = value.trim();
    }
  });
  return config;
}

const config = loadConfig();
const token = config.TOKEN;
const tgId = config.TG_ID;
const parallelAds = parseInt(config.PARALLEL_ADS) || 1;
const adViewInterval = parseInt(config.AD_VIEW_INTERVAL) || 60000;

class WhiteBunnyBot {
  constructor(token, tgId, parallelAds, adViewInterval) {
    this.token = token;
    this.tgId = tgId;
    this.parallelAds = parallelAds;
    this.adViewInterval = adViewInterval;
    this.headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://game.whitebunny.wtf',
      'Referer': 'https://game.whitebunny.wtf/',
    };
    this.wsUrl = null;
    this.ws = null;
    this.isRunning = false;
    this.retryCount = 0;
    this.maxRetries = 10;
    this.debugMode = true;
    this.knownServers = [
      'api-fra-2.whitebunny.wtf',
      'api-fra-1.whitebunny.wtf'
    ];
    this.currentServerIndex = 0;
    this.reconnectTimeout = null;
    this.pingInterval = null;
    this.adViewingInterval = null;
    this.lastAdTime = 0;
    this.adCooldown = 35000;
    this.restartOnDisconnect = true;
  }

  log(message, data = null) {
    let color = '\x1b[37m'; 

    if (message.includes('Skipping failed view ad:')) {
      color = '\x1b[31m'; 
    } else if (message.includes('Starting to view ad')) {
      color = '\x1b[37m'; 
    } else if (message.includes('Points:')) {
      color = '\x1b[33m'; 
    } else if (message.includes('Reward response:') || message.includes('Ad view completed')) {
      color = '\x1b[32m'; 
    } else if (message.includes('Starting bot') || message.includes('Connecting to server') || message.includes('Connected to WebSocket')) {
      color = '\x1b[36m'; 
    }

    console.log(`${color}[${new Date().toISOString()}] ${message}\x1b[0m`);

    if (data) console.log(data);
  }
  
  async startViewingAds() {
    this.log('Starting parallel ad viewing...');

    while (true) {
      const adViewTasks = [];
      for (let i = 0; i < this.parallelAds; i++) {
        adViewTasks.push(this.viewAd());
      }

      await Promise.all(adViewTasks);

      this.log(`Waiting ${this.adViewInterval / 1000} seconds before the next cycle...`);
      await new Promise(resolve => setTimeout(resolve, this.adViewInterval));
    }
  }

  async viewAd() {
    try {
        const adResponse = await axios.get('https://api.adsgram.ai/adv', {
            params: {
                blockId: 1440,
                tg_id: this.tgId,
                tg_platform: 'tdesktop',
                platform: 'Win32',
                language: 'en',
                is_premium: true
            },
            headers: this.headers
        });

        const adData = adResponse.data;
        if (!adData || !adData.banner || !adData.banner.trackings) {
            throw new Error('Invalid ad data received');
        }

        const bannerAssets = adData.banner.bannerAssets;
        const trackings = {};
        for (const tracking of adData.banner.trackings) {
            trackings[tracking.name] = tracking.value;
        }

        if (!trackings.render || !trackings.show || !trackings.reward) {
            throw new Error('Missing tracking URLs');
        }

        const adTitle = bannerAssets.find(asset => asset.name === 'title')?.value || 'Unknown';
        const adDescription = bannerAssets.find(asset => asset.name === 'description')?.value || 'Unknown';

        this.log(`Starting to view ad... (Title: ${adTitle}, Description: ${adDescription})`);

        await axios.get(trackings.render, { headers: this.headers });
        await axios.get(trackings.show, { headers: this.headers });

        const adDuration = Math.floor(Math.random() * (32000 - 15000) + 15000);
        await new Promise(resolve => setTimeout(resolve, adDuration));

        const rewardResponse = await axios.get(trackings.reward, { headers: this.headers });
        this.log('Reward response:', rewardResponse.data);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send('42["checkTask",{"code":"rewardAds10000"}]');
            this.log('Sent task check for rewardAds10000');
        }

        this.log('Ad view completed and reward claimed!');
    } catch (error) {
        this.log('Skipping failed view ad:', error.message); // Log the failure and skip it
    }
  }
  
  startPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('2');
        this.log('Ping sent');
      }
    }, 1000000000);
  }

  async start() {
    try {
      this.log('Starting bot...');
      await this.connectToServer();
      this.startTapping();
      this.startViewingAds();
    } catch (error) {
      console.error('Failed to start bot:', error.message);
      await this.handleReconnect();
    }
  }

  async handleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      this.currentServerIndex = (this.currentServerIndex + 1) % this.knownServers.length;
      this.log(`Retrying with next server... Attempt ${this.retryCount}/${this.maxRetries}`);
      
      if (this.ws) {
        this.ws.terminate(); 
        this.ws = null;
      }
      
      this.wsUrl = null;
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      return this.start();
    } else {
      console.error('Max retries reached. Stopping bot.');
      this.stop();
    }
  }

  async connectToServer() {
    const currentServer = this.knownServers[this.currentServerIndex];
    this.log(`Connecting to server: ${currentServer}`);
    
    try {
      const serverUrl = `https://${currentServer}`;
      await this.initializeConnection(serverUrl);
      await this.connectWebSocket();
      this.startTapping();
    } catch (error) {
      this.log(`Failed to connect to ${currentServer}: ${error.message}`);
      throw error;
    }
  }

  async initializeConnection(serverUrl) {
    const pollingUrl = `${serverUrl}/socket.io/?EIO=4&transport=polling&t=${this.generateTimestamp()}`;
    
    const socketResponse = await axios.get(pollingUrl, {
      headers: {
        ...this.headers,
        'Authorization': this.token
      }
    });
    
    const dataStr = socketResponse.data.toString();
    const jsonStr = dataStr.slice(dataStr.indexOf('{'));
    const socketData = JSON.parse(jsonStr);
    
    if (!socketData.sid) {
      throw new Error('No session ID in socket response');
    }

    await axios.post(
      `${pollingUrl}&sid=${socketData.sid}`,
      '40',
      {
        headers: {
          ...this.headers,
          'Authorization': this.token,
          'Content-Type': 'text/plain;charset=UTF-8'
        }
      }
    );

    this.wsUrl = `${serverUrl.replace('https://', 'wss://')}/socket.io/?EIO=4&transport=websocket&sid=${socketData.sid}`;
  }

  generateTimestamp() {
    return `P${Math.random().toString(36).substr(2, 4)}`;
  }

  async connectWebSocket() {
    return new Promise((resolve, reject) => {
      if (this.ws) {
        this.ws.terminate();
        this.ws = null;
      }

      this.ws = new WebSocket(this.wsUrl, {
        headers: {
          ...this.headers,
          'Authorization': this.token
        }
      });

      let connectionTimeout = setTimeout(() => {
        if (this.ws.readyState !== WebSocket.OPEN) {
          this.log('Connection timeout');
          this.ws.terminate();
          reject(new Error('Connection timeout'));
        }
      }, 5000);

      this.ws.on('open', () => {
        this.log('Connected to WebSocket');
        this.ws.send('2probe');
      });

      this.ws.on('message', (data) => {
        const message = data.toString();
        
        if (message === '3probe') {
          clearTimeout(connectionTimeout);
          this.ws.send('5');
          this.startPingInterval();
          this.retryCount = 0;
          resolve();
        } else if (message.startsWith('44{"message":"Unauthorized"}')) {
          clearTimeout(connectionTimeout);
          reject(new Error('Unauthorized - please check your token'));
        } else {
          this.handleMessage(message);
        }
      });

      this.ws.on('error', (error) => {
        clearTimeout(connectionTimeout);
        console.error('WebSocket error:', error.message);
        if (this.pingInterval) clearInterval(this.pingInterval);
        reject(error);
      });

      this.ws.on('close', async (code, reason) => {
        clearTimeout(connectionTimeout);
        if (this.pingInterval) clearInterval(this.pingInterval);
        
        this.log(`Disconnected: ${code}`);
        
        if (this.isRunning) {
          if (this.restartOnDisconnect) {
            this.log('Initiating full bot restart...');
            this.restartBot();
          } else {
            await this.handleReconnect();
          }
        }
      });
    });
  }
  
  restartBot() {
    this.log('Stopping current bot instance...');
    this.stop();
    
    this.log('Restarting bot process...');
    exec('node ' + process.argv[1], (error, stdout, stderr) => {
      if (error) {
        console.error(`Error restarting bot: ${error}`);
        return;
      }
      process.exit(0);
    });
  }

  handleMessage(message) {
    if (message.startsWith('42')) {
      try {
        const [messageType, data] = JSON.parse(message.slice(2));
        
        if (messageType === 'update') {
          this.log(`${data.firstname} - Points: ${data.totalPoint}`);
        }
      } catch (error) {
        console.error('Failed to parse message:', error.message);
      }
    }
  }

  startTapping() {
    this.isRunning = true;
    this.log('Starting auto-tap...');
    
    const tapInterval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(tapInterval);
        return;
      }
      
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('42["tapBunny"]');
      }
    }, 100);
  }

  stop() {
    this.isRunning = false;
    if (this.ws) {
      this.ws.terminate();
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    if (this.adViewingInterval) {
      clearInterval(this.adViewingInterval);
    }
  }
}

if (!token || !tgId) {
  console.error('Please provide TOKEN and TG_ID in data.txt');
  process.exit(1);
}

const bot = new WhiteBunnyBot(token, tgId, parallelAds, adViewInterval);
bot.start().catch(console.error);

process.on('SIGINT', () => {
  console.log('Stopping bot...');
  bot.stop();
  process.exit(0);
});
