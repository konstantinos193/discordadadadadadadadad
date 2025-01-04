const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

// Contract addresses
const NFT_CONTRACT_ADDRESS = '0x485242262f1e367144fe432ba858f9ef6f491334';
const STAKING_CONTRACT_ADDRESS = '0xdDbcC239527Dedd5E0c761042ef02A7951cEC315';

// ABI snippets for the functions we need
const NFT_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function ownerOf(uint256 tokenId) view returns (address)'
];

const STAKING_ABI = [
    {
        "inputs": [{"name": "_staker", "type": "address"}],
        "name": "getStakerInfo",
        "outputs": [
            {"name": "stakedTokens", "type": "uint256[]"},
            {"name": "totalPoints", "type": "uint256"},
            {"name": "tier", "type": "uint256"},
            {"name": "isMinter", "type": "bool"}
        ],
        "stateMutability": "view",
        "type": "function"
    }
];

const app = express();

// Enable CORS
app.use(cors());

// Initialize session maps
const sessions = new Map();
const discordSessions = new Map();

// Make sessions available to routes
app.set('sessions', sessions);
app.set('discordSessions', discordSessions);

// API Keys (store these in your .env file)
const BOT_API_KEY = process.env.BOT_API_KEY || uuidv4();
const FRONTEND_API_KEY = process.env.FRONTEND_API_KEY || uuidv4();
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});

// API key validation middleware
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    
    console.log('API Key Validation:', {
        receivedKey: apiKey,
        botKey: BOT_API_KEY,
        frontendKey: FRONTEND_API_KEY,
        matches: {
            bot: apiKey === BOT_API_KEY,
            frontend: apiKey === FRONTEND_API_KEY
        },
        path: req.path
    });
    
    if (!apiKey) {
        console.log('No API key provided');
        return res.status(401).json({ error: 'API key required' });
    }
    
    if (apiKey !== BOT_API_KEY && apiKey !== FRONTEND_API_KEY) {
        console.log('Invalid API key provided:', {
            receivedKey: apiKey,
            validKeys: {
                bot: BOT_API_KEY,
                frontend: FRONTEND_API_KEY
            }
        });
        return res.status(403).json({ error: 'Invalid API key' });
    }
    
    console.log('API key validation successful for path:', req.path);
    next();
};

// Apply middleware
app.use(limiter);
app.use(express.json());

// Serve static files from the public directory
app.use(express.static('public'));

// Apply API key validation only to API routes
app.use('/api', validateApiKey);

// Verification endpoint
app.get('/verify', (req, res) => {
    try {
        const { session } = req.query;
        if (!session) {
            return res.status(400).json({ error: 'Session ID is required' });
        }

        // Serve the verification page
        res.sendFile('public/verify.html', { root: __dirname });
    } catch (error) {
        console.error('Error serving verification page:', error);
        res.status(500).json({ error: error.message });
    }
});

// Session management
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

// Create new session
app.post('/api/session', validateApiKey, (req, res) => {
    try {
        const { discordId, username } = req.body;
        
        // Generate a proper UUID for the session
        const sessionId = uuidv4();
        
        // Create session with all required fields
        const session = {
            id: sessionId,
            discordId,
            username,
            isDiscordConnected: true,
            wallets: [],
            createdAt: Date.now(),
            lastActivity: Date.now()
        };

        // Store in both maps
        sessions.set(sessionId, session);
        discordSessions.set(discordId, session);

        console.log('Created new session:', session);

        res.json({ 
            success: true,
            sessionId,
            session 
        });
    } catch (error) {
        console.error('Error creating session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get session status
app.get('/api/session/:sessionId', validateApiKey, (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = sessions.get(sessionId);
        
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        res.json(session);
    } catch (error) {
        console.error('Error getting session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Cleanup expired sessions
function cleanupSessions() {
    const now = Date.now();
    sessions.forEach((session, sessionId) => {
        if (now - session.lastActivity > SESSION_TIMEOUT) {
            console.log('Cleaning up expired session:', sessionId);
            sessions.delete(sessionId);
            if (session.discordId) {
                discordSessions.delete(session.discordId);
            }
        }
    });
}

// Run cleanup every hour
setInterval(cleanupSessions, 60 * 60 * 1000);

// Import and use dashboard routes
const dashboardRoutes = require('./routes/dashboard');
app.use('/api', dashboardRoutes);

// Basic health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        sessions: {
            discord: Array.from(discordSessions.keys()),
            wallet: Array.from(sessions.keys())
        }
    });
});

// Discord session endpoint
app.get('/api/discord/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    console.log('Fetching Discord session:', sessionId);

    const session = discordSessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json(session);
});

// Discord webhook endpoint
app.post('/api/discord/webhook', validateApiKey, (req, res) => {
    try {
        const { sessionId, username, discordId } = req.body;
        
        console.log('Webhook received:', {
            sessionId,
            username,
            discordId,
            rawBody: req.body
        });

        if (!sessionId || !username || !discordId) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                received: { sessionId, username, discordId }
            });
        }

        // Create session with proper data
        const session = {
            id: sessionId,
            discordId,
            username: decodeURIComponent(username),
            isDiscordConnected: true,
            wallets: [],
            createdAt: Date.now(),
            lastActivity: Date.now(),
            timestamp: Date.now()
        };

        // Store session in both maps
        sessions.set(sessionId, session);
        discordSessions.set(discordId, session);

        console.log('Created new session:', session);

        res.json({
            success: true,
            sessionId,
            session
        });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Wallet verification endpoint
app.post('/api/discord/:sessionId/wallets', validateApiKey, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { address, signature, message, timestamp } = req.body;

        console.log('Wallet verification request:', {
            sessionId,
            address,
            timestamp,
            hasSignature: !!signature
        });

        // Validate session exists
        const session = sessions.get(sessionId);
        if (!session) {
            console.error('Session not found:', sessionId);
            return res.status(404).json({ error: 'Session not found' });
        }

        // Verify wallet ownership through signature
        const recoveredAddress = ethers.verifyMessage(message, signature);
        if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
            console.error('Invalid signature');
            return res.status(400).json({ error: 'Invalid signature' });
        }

        // Add wallet to session
        session.wallets = session.wallets || [];
        if (!session.wallets.find(w => w.address.toLowerCase() === address.toLowerCase())) {
            session.wallets.push({
                address,
                verified: true,
                verifiedAt: Date.now()
            });
        }

        // Update session
        sessions.set(sessionId, session);

        res.json({
            success: true,
            session
        });

    } catch (error) {
        console.error('Wallet verification error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    log('ERROR', 'Unhandled error occurred', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
    });
    res.status(500).json({
        error: err.message,
        status: 'error'
    });
});

// Add CORS headers to all responses
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Debug logging middleware
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`, {
        headers: req.headers,
        query: req.query,
        body: req.body
    });
    next();
});

// Health check endpoint
app.get('/health', (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        startupTime,
        memory: process.memoryUsage(),
        environment: process.env.NODE_ENV || 'development',
        sessions: {
            total: sessions.size,
            discord: discordSessions.size
        }
    };
    
    log('HEALTH_CHECK', 'Health check requested', health);
    res.json(health);
});

// Add request logging middleware (place this before your routes)
app.use((req, res, next) => {
    const start = Date.now();
    
    res.on('finish', () => {
        log('REQUEST', `${req.method} ${req.path}`, {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration: Date.now() - start,
            ip: req.ip,
            userAgent: req.get('user-agent')
        });
    });
    
    next();
});

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    log('SERVER_STARTED', `API Server is running on port ${PORT}`, {
        port: PORT,
        node_env: process.env.NODE_ENV,
        uptime: process.uptime()
    });
});

// Export everything needed
module.exports = app;

app.sessions = sessions;
app.discordSessions = discordSessions;
app.NFT_CONTRACT_ADDRESS = NFT_CONTRACT_ADDRESS;
app.STAKING_CONTRACT_ADDRESS = STAKING_CONTRACT_ADDRESS;
app.NFT_ABI = NFT_ABI;
app.STAKING_ABI = STAKING_ABI;
