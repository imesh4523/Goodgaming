import TelegramBot from 'node-telegram-bot-api';
import { storage } from './storage';

let bot: TelegramBot | null = null;
let currentBotToken: string | null = null;

export async function initializeTelegramBot(forceReload: boolean = false): Promise<boolean> {
  try {
    const tokenSetting = await storage.getSystemSetting('telegram_bot_token');
    
    if (!tokenSetting || !tokenSetting.value) {
      console.log('Telegram bot token not configured');
      return false;
    }

    // Reinitialize if token has changed or force reload is requested
    if (forceReload || currentBotToken !== tokenSetting.value) {
      if (bot) {
        // Clean up old bot instance
        try {
          await bot.close();
        } catch (e) {
          // Ignore close errors
        }
        bot = null;
      }
      
      bot = new TelegramBot(tokenSetting.value, { polling: false });
      currentBotToken = tokenSetting.value;
      console.log('✅ Telegram bot initialized successfully');
    }
    
    return true;
  } catch (error) {
    console.error('Failed to initialize Telegram bot:', error);
    currentBotToken = null;
    bot = null;
    return false;
  }
}

export async function sendWithdrawalNotification(
  userName: string,
  amount: string,
  paymentMethod: string,
  time: string
): Promise<boolean> {
  try {
    const chatIdSetting = await storage.getSystemSetting('telegram_chat_id');
    
    if (!chatIdSetting || !chatIdSetting.value) {
      console.log('Telegram chat ID not configured');
      return false;
    }

    // Always check if we need to reinitialize (in case token was updated)
    const initialized = await initializeTelegramBot();
    if (!initialized || !bot) {
      return false;
    }

    const message = `
🔔 NEW WITHDRAWAL REQUEST

👤 User: ${userName}
💰 Amount: $${amount}
💳 Payment: ${paymentMethod}
⏰ Time: ${time}

👉 Check admin panel now
    `.trim();

    await bot.sendMessage(chatIdSetting.value, message);
    console.log('✅ Telegram notification sent successfully');
    return true;
  } catch (error) {
    console.error('Failed to send Telegram notification:', error);
    
    // If authorization error, force reload and retry once
    if (error instanceof Error && error.message.includes('401')) {
      console.log('⚠️ Authorization error, attempting to reload bot token...');
      try {
        const chatIdSetting = await storage.getSystemSetting('telegram_chat_id');
        if (!chatIdSetting || !chatIdSetting.value) {
          return false;
        }
        
        const reinitialized = await initializeTelegramBot(true);
        if (reinitialized && bot) {
          const message = `
🔔 NEW WITHDRAWAL REQUEST

👤 User: ${userName}
💰 Amount: $${amount}
💳 Payment: ${paymentMethod}
⏰ Time: ${time}

👉 Check admin panel now
          `.trim();
          await bot.sendMessage(chatIdSetting.value, message);
          console.log('✅ Telegram notification sent successfully after token reload');
          return true;
        }
      } catch (retryError) {
        console.error('Failed to send notification after token reload:', retryError);
      }
    }
    
    return false;
  }
}

export async function testTelegramConnection(): Promise<boolean> {
  try {
    const chatIdSetting = await storage.getSystemSetting('telegram_chat_id');
    
    if (!chatIdSetting || !chatIdSetting.value) {
      console.log('Telegram chat ID not configured');
      return false;
    }

    // Always reload token for test (to ensure we're using latest settings)
    const initialized = await initializeTelegramBot(true);
    if (!initialized || !bot) {
      return false;
    }

    const message = '✅ Test notification successful! Your Telegram bot is working correctly.';
    await bot.sendMessage(chatIdSetting.value, message);
    return true;
  } catch (error) {
    console.error('Failed to send test notification:', error);
    
    // Clear cached token on error so next attempt will retry
    currentBotToken = null;
    bot = null;
    
    return false;
  }
}

export async function getChatId(botToken: string): Promise<string | null> {
  try {
    const tempBot = new TelegramBot(botToken, { polling: false });
    const updates = await tempBot.getUpdates({ limit: 1, offset: -1 });
    
    if (updates.length > 0 && updates[0].message?.chat?.id) {
      return updates[0].message.chat.id.toString();
    }
    
    return null;
  } catch (error) {
    console.error('Failed to get chat ID:', error);
    return null;
  }
}

export async function sendGameSignal(
  gameId: string,
  duration: number = 3,
  photoUrl?: string
): Promise<boolean> {
  try {
    const signalEnabledSetting = await storage.getSystemSetting('telegram_signals_enabled');
    
    if (!signalEnabledSetting || signalEnabledSetting.value !== 'true') {
      console.log('Telegram signals are disabled');
      return false;
    }

    const signalChatIdSetting = await storage.getSystemSetting('telegram_signal_chat_id');
    
    if (!signalChatIdSetting || !signalChatIdSetting.value) {
      console.log('Telegram signal chat ID not configured');
      return false;
    }

    const initialized = await initializeTelegramBot();
    if (!initialized || !bot) {
      return false;
    }

    const colors = ['🟢', '🔴', '🟣'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];

    const message = `WinGo ${duration} min\n🎉  ${gameId}    Join   ${randomColor}`;

    // Send photo with caption if photoUrl is provided
    if (photoUrl) {
      await bot.sendPhoto(signalChatIdSetting.value, photoUrl, { 
        caption: message 
      });
      console.log('✅ Telegram signal with photo sent successfully:', message);
    } else {
      await bot.sendMessage(signalChatIdSetting.value, message);
      console.log('✅ Telegram signal sent successfully:', message);
    }
    return true;
  } catch (error) {
    console.error('Failed to send Telegram signal:', error);
    
    if (error instanceof Error && error.message.includes('401')) {
      console.log('⚠️ Authorization error, attempting to reload bot token...');
      try {
        const signalChatIdSetting = await storage.getSystemSetting('telegram_signal_chat_id');
        if (!signalChatIdSetting || !signalChatIdSetting.value) {
          return false;
        }
        
        const reinitialized = await initializeTelegramBot(true);
        if (reinitialized && bot) {
          const colors = ['🟢', '🔴', '🟣'];
          const randomColor = colors[Math.floor(Math.random() * colors.length)];
          const message = `WinGo ${duration} min\n🎉  ${gameId}    Join   ${randomColor}`;
          
          if (photoUrl) {
            await bot.sendPhoto(signalChatIdSetting.value, photoUrl, { 
              caption: message 
            });
            console.log('✅ Telegram signal with photo sent successfully after token reload');
          } else {
            await bot.sendMessage(signalChatIdSetting.value, message);
            console.log('✅ Telegram signal sent successfully after token reload');
          }
          return true;
        }
      } catch (retryError) {
        console.error('Failed to send signal after token reload:', retryError);
      }
    }
    
    return false;
  }
}

export async function sendPhotoToSignalChannel(
  photoUrl: string,
  caption?: string
): Promise<boolean> {
  try {
    const signalEnabledSetting = await storage.getSystemSetting('telegram_signals_enabled');
    
    if (!signalEnabledSetting || signalEnabledSetting.value !== 'true') {
      console.log('Telegram signals are disabled');
      return false;
    }

    const signalChatIdSetting = await storage.getSystemSetting('telegram_signal_chat_id');
    
    if (!signalChatIdSetting || !signalChatIdSetting.value) {
      console.log('Telegram signal chat ID not configured');
      return false;
    }

    const initialized = await initializeTelegramBot();
    if (!initialized || !bot) {
      return false;
    }

    await bot.sendPhoto(signalChatIdSetting.value, photoUrl, { 
      caption: caption || '' 
    });
    console.log('✅ Photo sent to Telegram signal channel successfully');
    return true;
  } catch (error) {
    console.error('Failed to send photo to Telegram signal channel:', error);
    
    if (error instanceof Error && error.message.includes('401')) {
      console.log('⚠️ Authorization error, attempting to reload bot token...');
      try {
        const signalChatIdSetting = await storage.getSystemSetting('telegram_signal_chat_id');
        if (!signalChatIdSetting || !signalChatIdSetting.value) {
          return false;
        }
        
        const reinitialized = await initializeTelegramBot(true);
        if (reinitialized && bot) {
          await bot.sendPhoto(signalChatIdSetting.value, photoUrl, { 
            caption: caption || '' 
          });
          console.log('✅ Photo sent to Telegram signal channel after token reload');
          return true;
        }
      } catch (retryError) {
        console.error('Failed to send photo after token reload:', retryError);
      }
    }
    
    return false;
  }
}

export async function sendAdminLoginNotification(
  adminEmail: string,
  ipAddress: string,
  timestamp: string
): Promise<boolean> {
  try {
    const chatIdSetting = await storage.getSystemSetting('telegram_chat_id');
    
    if (!chatIdSetting || !chatIdSetting.value) {
      console.log('Telegram chat ID not configured');
      return false;
    }

    const initialized = await initializeTelegramBot();
    if (!initialized || !bot) {
      return false;
    }

    const message = `
🔐 ADMIN LOGIN DETECTED

👤 User: ${adminEmail}
🌐 IP Address: ${ipAddress}
⏰ Time: ${timestamp}

🔔 An admin has logged into the dashboard.
    `.trim();

    await bot.sendMessage(chatIdSetting.value, message);
    console.log('✅ Admin login notification sent successfully');
    return true;
  } catch (error) {
    console.error('Failed to send admin login notification:', error);
    
    if (error instanceof Error && error.message.includes('401')) {
      console.log('⚠️ Authorization error, attempting to reload bot token...');
      try {
        const chatIdSetting = await storage.getSystemSetting('telegram_chat_id');
        if (!chatIdSetting || !chatIdSetting.value) {
          return false;
        }
        
        const reinitialized = await initializeTelegramBot(true);
        if (reinitialized && bot) {
          const message = `
🔐 ADMIN LOGIN DETECTED

👤 User: ${adminEmail}
🌐 IP Address: ${ipAddress}
⏰ Time: ${timestamp}

🔔 An admin has logged into the dashboard.
          `.trim();
          await bot.sendMessage(chatIdSetting.value, message);
          console.log('✅ Admin login notification sent successfully after token reload');
          return true;
        }
      } catch (retryError) {
        console.error('Failed to send notification after token reload:', retryError);
      }
    }
    
    return false;
  }
}

export async function sendFailedLoginNotification(
  email: string,
  ipAddress: string,
  timestamp: string
): Promise<boolean> {
  try {
    const chatIdSetting = await storage.getSystemSetting('telegram_chat_id');
    
    if (!chatIdSetting || !chatIdSetting.value) {
      console.log('Telegram chat ID not configured');
      return false;
    }

    const initialized = await initializeTelegramBot();
    if (!initialized || !bot) {
      return false;
    }

    const message = `
⚠️ FAILED LOGIN ATTEMPT

👤 Email: ${email}
🌐 IP Address: ${ipAddress}
⏰ Time: ${timestamp}

🔒 Invalid credentials provided.
    `.trim();

    await bot.sendMessage(chatIdSetting.value, message);
    console.log('✅ Failed login notification sent successfully');
    return true;
  } catch (error) {
    console.error('Failed to send failed login notification:', error);
    
    if (error instanceof Error && error.message.includes('401')) {
      console.log('⚠️ Authorization error, attempting to reload bot token...');
      try {
        const chatIdSetting = await storage.getSystemSetting('telegram_chat_id');
        if (!chatIdSetting || !chatIdSetting.value) {
          return false;
        }
        
        const reinitialized = await initializeTelegramBot(true);
        if (reinitialized && bot) {
          const message = `
⚠️ FAILED LOGIN ATTEMPT

👤 Email: ${email}
🌐 IP Address: ${ipAddress}
⏰ Time: ${timestamp}

🔒 Invalid credentials provided.
          `.trim();
          await bot.sendMessage(chatIdSetting.value, message);
          console.log('✅ Failed login notification sent successfully after token reload');
          return true;
        }
      } catch (retryError) {
        console.error('Failed to send notification after token reload:', retryError);
      }
    }
    
    return false;
  }
}

export async function sendInvalid2FANotification(
  email: string,
  ipAddress: string,
  timestamp: string
): Promise<boolean> {
  try {
    const chatIdSetting = await storage.getSystemSetting('telegram_chat_id');
    
    if (!chatIdSetting || !chatIdSetting.value) {
      console.log('Telegram chat ID not configured');
      return false;
    }

    const initialized = await initializeTelegramBot();
    if (!initialized || !bot) {
      return false;
    }

    const message = `
⚠️ INVALID 2FA CODE ATTEMPT

👤 User: ${email}
🌐 IP Address: ${ipAddress}
⏰ Time: ${timestamp}

🔒 Someone entered a wrong 2FA code.
    `.trim();

    await bot.sendMessage(chatIdSetting.value, message);
    console.log('✅ Invalid 2FA notification sent successfully');
    return true;
  } catch (error) {
    console.error('Failed to send invalid 2FA notification:', error);
    
    if (error instanceof Error && error.message.includes('401')) {
      console.log('⚠️ Authorization error, attempting to reload bot token...');
      try {
        const chatIdSetting = await storage.getSystemSetting('telegram_chat_id');
        if (!chatIdSetting || !chatIdSetting.value) {
          return false;
        }
        
        const reinitialized = await initializeTelegramBot(true);
        if (reinitialized && bot) {
          const message = `
⚠️ INVALID 2FA CODE ATTEMPT

👤 User: ${email}
🌐 IP Address: ${ipAddress}
⏰ Time: ${timestamp}

🔒 Someone entered a wrong 2FA code.
          `.trim();
          await bot.sendMessage(chatIdSetting.value, message);
          console.log('✅ Invalid 2FA notification sent successfully after token reload');
          return true;
        }
      } catch (retryError) {
        console.error('Failed to send notification after token reload:', retryError);
      }
    }
    
    return false;
  }
}
