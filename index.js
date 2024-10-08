import WebSocket from 'ws';
import axios from 'axios';
import readline from 'readline';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';
import chalk from 'chalk'; 

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} | ${level.toUpperCase()} | ${message} | t.me/slyntherinnn`;
    })
  ),
  transports: [
    new winston.transports.Console(),
  ],
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WhiteBunnyGame {
  constructor() {
    this.token = null;
    this.ws = null;
    this.gameServer = null;
    this.socketIOSid = null;
    this.apiKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5waWJma3J4Y2VpamZhdm1zc3RyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MTgwMzY2NjksImV4cCI6MjAzMzYxMjY2OX0.tzFCWLAgY6nEVB8mMqHnNBn3p4iYXt9Z5U6lpE_1Iz0';
    this.userId = '1118770958';
    this.isReconnecting = false;
    this.pingInterval = null;
	this.adInProgress = false;
    this.currentAdRewardResolver = null;
	this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.baseReconnectDelay = 1000;
	this.rewardClaimAttempts = 0;
    this.maxRewardClaimAttempts = 3;
    this.rewardClaimTimeout = 45000;
	this.adDuration = 32000; 
    this.rewardClaimRetries = 0;
    this.maxRewardClaimRetries = 3;
    this.rewardClaimDelay = 2000; 
    this.rewardTimeout = 8000;
    
    this.headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://game.whitebunny.wtf',
      'Referer': 'https://game.whitebunny.wtf/'
    };

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  async initializeWithToken(token) {
    this.token = token;
    await this.getGameServer();
    await this.initializeSocketIO();
  }

  async getGameServer() {
    try {
      const response = await axios.get('https://api.whitebunny.wtf/which-server', {
        headers: this.headers
      });
      this.gameServer = response.data.url;
      logger.info(chalk.blueBright(`Game server: ${this.gameServer}`));
    } catch (error) {
      logger.error(chalk.red('Failed to get game server:'), error.message);
      throw error;
    }
  }

  async initializeSocketIO() {
    try {
      const pollingUrl = `${this.gameServer}/socket.io/?EIO=4&transport=polling&t=${Date.now()}`;
      const response = await axios.get(pollingUrl, {
        headers: {
          ...this.headers,
          'Authorization': this.token
        }
      });

      const sidMatch = response.data.match(/"sid":"(.+?)"/);
      if (sidMatch) {
        this.socketIOSid = sidMatch[1];
        logger.info(chalk.green(`Socket.IO session ID: ${this.socketIOSid}`));
        await this.connectWebSocket();
      } else {
        throw new Error('Failed to get Socket.IO session ID');
      }
    } catch (error) {
      logger.error(chalk.red('Failed to initialize Socket.IO:'), error.message);
      throw error;
    }
  }

  setupWebSocketHandlers() {
    this.ws.on('open', () => {
      logger.info(chalk.blueBright('WebSocket connected'));
      this.ws.send('2probe');
    });

    this.ws.on('message', (data) => {
      const message = data.toString();
      logger.debug(chalk.gray(`Received: ${message}`));
      
      if (message === '3probe') {
        this.ws.send('5');
        this.startPingInterval();
      } else if (message === '3') {
        this.ws.send('2'); 
      } else if (message.startsWith('42["update"')) {
        if (this.adInProgress && this.currentAdRewardResolver) {
          try {
            const updateData = JSON.parse(message.substring(2))[1];
            if (updateData && updateData.totalPoint) {
              logger.info(chalk.green(`Ad reward confirmed! New total points: ${updateData.totalPoint}`));
              this.currentAdRewardResolver(true);
              this.currentAdRewardResolver = null;
              this.adInProgress = false;
            }
          } catch (error) {
            logger.error(chalk.red('Error parsing update message:', error.message));
          }
        }
      }
    });

    this.ws.on('close', () => {
      logger.warn(chalk.red('WebSocket connection closed'));
      this.clearPingInterval();
      if (!this.isReconnecting) {
        this.handleDisconnection();
      }
    });

    this.ws.on('error', (error) => {
      logger.error(chalk.red('WebSocket error:'), error.message);
      this.clearPingInterval();
      if (!this.isReconnecting) {
        this.handleDisconnection();
      }
    });
  }
  
  async handleDisconnection() {
    await new Promise(resolve => setTimeout(resolve, 1000)); 
    if (this.adInProgress) {
      logger.warn(chalk.yellow('Disconnected during ad viewing, attempting reconnection...'));
      await this.reconnectWebSocket();
      if (this.currentAdRewardResolver) {
        await new Promise(resolve => setTimeout(resolve, 1000)); 
        this.claimAdReward();
      }
    } else {
      await this.reconnectWebSocket();
    }
  }

  startPingInterval() {
    this.clearPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('2');
      }
    }, 15000);
  }

  clearPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  async reconnectWebSocket() {
    if (this.isReconnecting) return;
    
    this.isReconnecting = true;
    
    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      try {
        const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts);
        logger.info(chalk.yellow(`Waiting ${delay/1000} seconds before reconnection attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts}`));
        
        await new Promise(resolve => setTimeout(resolve, delay));
        
        await this.initializeSocketIO();
        this.isReconnecting = false;
        this.reconnectAttempts = 0; 
        logger.info(chalk.green('Successfully reconnected WebSocket'));
        return true;
      } catch (error) {
        this.reconnectAttempts++;
        logger.error(chalk.red(`Failed to reconnect WebSocket (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}):`, error.message));
      }
    }
    
    this.isReconnecting = false;
    logger.error(chalk.red(`Failed to reconnect after ${this.maxReconnectAttempts} attempts`));
    return false;
  }

  async connectWebSocket() {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.gameServer.replace('https', 'wss')}/socket.io/?EIO=4&transport=websocket&sid=${this.socketIOSid}`;
      
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': this.token
        }
      });

      this.setupWebSocketHandlers();

      const probeListener = (data) => {
        const message = data.toString();
        if (message === '3probe') {
          this.ws.removeListener('message', probeListener);
          resolve();
        }
      };
      this.ws.on('message', probeListener);

      setTimeout(() => {
        if (this.ws.readyState !== WebSocket.OPEN) {
          reject(new Error('WebSocket connection timeout'));
        }
      }, 10000);
    });
  }

  async watchAd() {
    try {
      this.adInProgress = true;
      logger.info(chalk.blueBright('Starting to watch ad...'));
    
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        logger.info(chalk.yellow('WebSocket not connected, attempting to reconnect...'));
        await this.reconnectWebSocket();
      }

      const rtbStatsResponse = await this.sendRtbStats();
      if (!rtbStatsResponse) {
        throw new Error('Failed to initialize ad viewing');
      }
      logger.info(chalk.green('Ad initialization successful'));

      const adInfo = await this.getAdInformation();
      if (!adInfo) {
        throw new Error('Failed to get ad information');
      }

      if (adInfo.duration) {
        this.adDuration = adInfo.duration * 1000; 
      }
      logger.info(chalk.cyan(`Ad duration set to ${this.adDuration/1000} seconds`));
    
      const events = ['render', 'show'];
      for (const eventType of events) {
        const success = await this.sendAdEvent(eventType, adInfo.banner.trackings);
        if (!success) {
          logger.warn(chalk.yellow(`Failed to send ${eventType} event`));
        }
        
        if (eventType === 'show') {
          logger.info(chalk.blueBright(`Waiting for ad duration (${this.adDuration/1000} seconds)...`));
          await new Promise(resolve => setTimeout(resolve, this.adDuration));
        }
      }

      const rewardSuccess = await this.sendAdEvent('reward', adInfo.banner.trackings);
      if (!rewardSuccess) {
        logger.error(chalk.red('Failed to send reward event'));
        return false;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      
      return await this.claimRewardWithRetry();
    } catch (error) {
      logger.error(chalk.red('Error watching ad:'), error.message);
      this.adInProgress = false;
      return false;
    }
  }
  
  async claimRewardWithRetry() {
    this.rewardClaimRetries = 0;
    
    return new Promise(async (resolve) => {
      const claimReward = async () => {
        if (this.rewardClaimRetries >= this.maxRewardClaimRetries) {
          logger.warn(chalk.magenta(`Failed to claim reward after ${this.maxRewardClaimRetries} attempts`));
          this.adInProgress = false;
          resolve(false);
          return;
        }

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          logger.info(chalk.yellow('Ensuring WebSocket connection before claiming reward...'));
          const reconnected = await this.reconnectWebSocket();
          if (!reconnected) {
            this.rewardClaimRetries++;
            setTimeout(claimReward, this.rewardClaimDelay);
            return;
          }
        }

        const rewardTimeoutId = setTimeout(() => {
          logger.warn(chalk.yellow(`Reward claim attempt ${this.rewardClaimRetries + 1} timed out`));
          this.rewardClaimRetries++;
          this.ws.removeAllListeners('message');
          setTimeout(claimReward, this.rewardClaimDelay);
        }, this.rewardTimeout);

        const messageHandler = (data) => {
          const message = data.toString();
          if (message.startsWith('42["update"')) {
            try {
              const updateData = JSON.parse(message.substring(2))[1];
              if (updateData && updateData.totalPoint) {
                clearTimeout(rewardTimeoutId);
                this.ws.removeAllListeners('message');
                logger.info(chalk.green(`Ad reward confirmed! New total points: ${updateData.totalPoint}`));
                this.adInProgress = false;
                resolve(true);
              }
            } catch (error) {
              logger.error(chalk.red('Error parsing update message:', error.message));
            }
          }
        };

        this.ws.on('message', messageHandler);

        this.claimAdReward();
        logger.info(chalk.blue(`Sent reward claim request (attempt ${this.rewardClaimRetries + 1}/${this.maxRewardClaimRetries})`));
      };

      await claimReward();
    });
  }

  async sendRtbStats() {
    try {
      const response = await axios.post(
        `https://api.tads.me/rest/v1/rpc/rtb_stats?apikey=${this.apiKey}`,
        {
          data: {
            wid: 29,
            uid: parseInt(this.userId),
            views: [1273, 1273]
          }
        },
        { headers: this.headers }
      );
      return response.data;
    } catch (error) {
      logger.error(chalk.red('Error sending RTB stats:'), error.message);
      return null;
    }
  }

  async getAdInformation() {
    try {
      const response = await axios.get(
        `https://api.adsgram.ai/adv?blockId=1440&tg_id=${this.userId}&tg_platform=tdesktop&platform=Win32&language=en&is_premium=true`,
        { headers: this.headers }
      );
   
      const adInfo = response.data;
      const adTitle = adInfo.banner.bannerAssets.find(asset => asset.name === "title")?.value || "Unknown Title";
      const adAdvertiser = adInfo.banner.bannerAssets.find(asset => asset.name === "advertiserName")?.value || "Unknown Advertiser";
    
      logger.info(chalk.cyan(`Ad Information:`));
      logger.info(chalk.cyan(`- Title: ${adTitle}`));
      logger.info(chalk.cyan(`- Advertiser: ${adAdvertiser}`));
      logger.info(chalk.cyan(`- Campaign ID: ${adInfo.campaignId}`));
      logger.info(chalk.cyan(`- Banner ID: ${adInfo.bannerId}`));
    
      return adInfo;
    } catch (error) {
      logger.error(chalk.red('Error getting ad information:'), error.message);
      return null;
    }
  }

  async sendAdEvent(type, trackings) {
    const tracking = trackings.find(t => t.name === type);
    if (!tracking) {
      logger.error(chalk.red(`No tracking URL found for event type: ${type}`));
      return false;
    }

    try {
      const response = await axios.get(tracking.value, { headers: this.headers });
      logger.info(chalk.green(`Successfully sent ${type} event. Status: ${response.status}`));
      
      if (type === 'reward') {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      return true;
    } catch (error) {
      logger.error(chalk.red(`Error sending ${type} event:`), error.message);
      return false;
    }
  }

  claimAdReward() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send('42["checkTask",{"code":"rewardAds10000"}]');
      logger.info(chalk.blue('Sent reward claim request'));
    } else {
      logger.error(chalk.red('WebSocket is not connected, cannot claim reward'));
    }
  }

  askForAdCount() {
    return new Promise((resolve) => {
      this.rl.question('How many ads would you like to watch? ', (answer) => {
        const count = parseInt(answer);
        if (isNaN(count) || count < 1) {
          logger.info(chalk.yellow('Please enter a valid number greater than 0.'));
          resolve(this.askForAdCount());
        } else {
          resolve(count);
        }
      });
    });
  }

  async watchAdsSequentially(count) {
    logger.info(chalk.blueBright(`Starting to watch ${count} ads...`));
    let successfulAds = 0;
    let consecutiveFailures = 0;
  
    for (let i = 0; i < count; i++) {
      logger.info(chalk.blueBright(`\nWatching ad ${i + 1} of ${count}`));
    
      let success = await this.watchAd();
    
      if (success) {
        logger.info(chalk.green(`Successfully completed ad ${i + 1}`));
        successfulAds++;
        consecutiveFailures = 0;
      
        if (i < count - 1) {
          const waitTime = Math.random() * (8000 - 5000) + 5000; 
          logger.info(chalk.blue(`Waiting ${Math.round(waitTime/1000)} seconds before next ad...`));
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      } else {
        consecutiveFailures++;
        logger.error(chalk.red(`Failed to complete ad ${i + 1}`));
      
        if (consecutiveFailures >= 3) {
          logger.error(chalk.red(`Stopping due to ${consecutiveFailures} consecutive failures`));
          break;
        }
      
        const waitTime = 10000 * consecutiveFailures; 
        logger.info(chalk.yellow(`Waiting ${waitTime/1000} seconds before trying next ad...`));
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  
    logger.info(chalk.blue(`\nCompleted watching ads. Successful: ${successfulAds}/${count}`));
    return successfulAds;
  }

  async start() {
    try {
      const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY2ZjE1ZThlZmVjN2Q0NWM0YWE0MWE5NiIsImlhdCI6MTcyNzg5NzA3NiwiZXhwIjoxNzkwOTY5MDc2fQ.1AIOECr5eFq8QFkjyV3goEQwAy2FnUgdwOyufly07HM';
      
      await this.initializeWithToken(token);
      
      const adCount = await this.askForAdCount();
      await this.watchAdsSequentially(adCount);

      logger.info(chalk.blue('\nBot is now idle. Press Ctrl+C to exit.'));

    } catch (error) {
      logger.error(chalk.red('Failed to start game:'), error.message);
    }
  }
}

// Run the bot
const game = new WhiteBunnyGame();
game.start();
