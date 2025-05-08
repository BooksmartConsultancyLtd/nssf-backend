import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';

const upload = multer();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 8080;

// Store WebSocket connections with their IDs
const clients = new Map();

// Enable CORS for all routes with specific configuration
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());

// Add a simple health check endpoint
app.get('/', (req, res) => {
  res.status(200).send('NSSF Registration Automation API is running');
});

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  // Handle both localhost and production URLs
  let id;
  try {
    // If req.url starts with /, it's a path, not a full URL
    let url;
    if (req.url.startsWith('/?id=')) {
      url = new URL(`https://localhost${req.url}`);
    } else {
      url = new URL(req.url, 'https://localhost');
    }
    id = url.searchParams.get('id');
  } catch (error) {
    console.error('Error parsing WebSocket URL:', error);
    // Try to extract id directly from URL if parsing fails
    const match = req.url.match(/[?&]id=([^&]+)/);
    id = match ? match[1] : null;
  }

  if (id) {
    clients.set(id, ws);
    console.log(`WebSocket client connected with ID: ${id}`);
  }

  ws.on('close', () => {
    if (id) {
      clients.delete(id);
      console.log(`WebSocket client disconnected: ${id}`);
    }
  });
});

// Function to send progress updates
const sendProgress = (id, status, progress) => {
  const ws = clients.get(id);
  if (ws && ws.readyState === 1) { // 1 = OPEN
    ws.send(JSON.stringify({ status, progress }));
    console.log(`Progress update sent to ${id}: ${status} ${progress}%`);
  }
};

// Handle both /api/submit-form and /submit-form for flexibility
app.post(['/api/submit-form', '/submit-form'], upload.none(), async (req, res) => {
  try {
    // Generate a unique request ID
    const requestId = Date.now().toString();

    const {
      firstName,
      middleName,
      surname,
      idNumber,
      dateOfBirth,
      districtOfBirth,
      mobileNumber,
      email
    } = req.body;

    // Generate a unique PDF output path
    const outDir = process.env.OUTPUT_DIR || '/tmp';
    // Use requestId in the filename for easier lookup
    const pdfFileName = `NSSF_${requestId}.pdf`;
    const pdfPath = path.join(outDir, pdfFileName);

    // Create output directory if it doesn't exist
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    // Send initial progress update
    sendProgress(requestId, 'starting', 0);

    // Spawn the Playwright automation script
    const args = [
      '--requestId', requestId,
      '--firstName', firstName,
      '--middleName', middleName,
      '--surname', surname,
      '--idNumber', idNumber,
      '--dateOfBirth', dateOfBirth,
      '--districtOfBirth', districtOfBirth,
      '--mobileNumber', mobileNumber,
      '--email', email,
      '--pdfPath', pdfPath
    ];

    const child = spawn('node', ['automation.js', ...args], {
      stdio: ['inherit', 'pipe', 'inherit'] // Capture stdout
    });

    // Listen for progress updates from the automation script
    child.stdout.on('data', (data) => {
      const output = data.toString().trim();
      console.log(`Automation output: ${output}`);
      if (output.startsWith('PROGRESS:')) {
        const percentage = parseInt(output.split(':')[1], 10);
        sendProgress(requestId, 'processing', percentage);
      }
    });

    // Listen for errors
    child.stderr.on('data', (data) => {
      console.error(`Automation error: ${data.toString().trim()}`);
      sendProgress(requestId, 'error', 0);
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        sendProgress(requestId, 'error', 100);
        res.status(500).json({
          success: false,
          message: 'Automation failed',
          requestId
        });
        return;
      }

      // Read PDF as base64 and send to client
      fs.readFile(pdfPath, { encoding: 'base64' }, (err, data) => {
        if (err) {
          sendProgress(requestId, 'error', 100);
          res.status(500).json({
            success: false,
            message: 'Failed to read PDF',
            requestId
          });
        } else {
          sendProgress(requestId, 'complete', 100);
          res.json({
            success: true,
            pdfData: data,
            requestId
          });
        }
        // Clean up PDF file
        fs.unlink(pdfPath, () => { });
      });
    });

    // Send the requestId immediately so frontend can connect to WebSocket
    res.json({
      success: true,
      message: 'Processing started',
      requestId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Status endpoint for polling fallback
app.get('/submit-form/status', async (req, res) => {
  try {
    const { id } = req.query;

    if (!id) {
      return res.status(400).json({ success: false, message: 'Missing request ID' });
    }

    // Check if we have PDF data for this request
    // In a real implementation, you would check a database or file storage
    // For now, we'll just return a status based on whether the WebSocket client exists
    const wsClient = clients.get(id);

    if (wsClient) {
      // Still processing
      res.json({
        success: true,
        status: 'processing',
        progress: 50 // You would track real progress in a production app
      });
    } else {
      // No WebSocket client found, check if we have completed data
      // This is a simplified example - in production you'd check a database
      const outDir = process.env.OUTPUT_DIR || '/tmp';
      const pdfPath = path.join(outDir, `NSSF_${id}.pdf`);

      if (fs.existsSync(pdfPath)) {
        const pdfData = fs.readFileSync(pdfPath, { encoding: 'base64' });
        res.json({
          success: true,
          status: 'complete',
          progress: 100,
          pdfData
        });

        // Clean up the file
        fs.unlink(pdfPath, () => { });
      } else {
        res.json({
          success: true,
          status: 'pending',
          progress: 30,
          message: 'PDF generation in progress'
        });
      }
    }
  } catch (err) {
    console.error('Status check error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to check status',
      status: 'error'
    });
  }
});

// Handle both API paths
app.get('/api/submit-form/status', async (req, res) => {
  try {
    // Forward to the main status endpoint
    const { id } = req.query;

    if (!id) {
      return res.status(400).json({ success: false, message: 'Missing request ID' });
    }

    // Check if we have PDF data for this request
    const wsClient = clients.get(id);

    if (wsClient) {
      // Still processing
      res.json({
        success: true,
        status: 'processing',
        progress: 50
      });
    } else {
      // No WebSocket client found, check if we have completed data
      const outDir = process.env.OUTPUT_DIR || '/tmp';
      const pdfPath = path.join(outDir, `NSSF_${id}.pdf`);

      if (fs.existsSync(pdfPath)) {
        const pdfData = fs.readFileSync(pdfPath, { encoding: 'base64' });
        res.json({
          success: true,
          status: 'complete',
          progress: 100,
          pdfData
        });

        // Clean up the file
        fs.unlink(pdfPath, () => { });
      } else {
        res.json({
          success: true,
          status: 'pending',
          progress: 30,
          message: 'PDF generation in progress'
        });
      }
    }
  } catch (err) {
    console.error('API status check error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to check status',
      status: 'error'
    });
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server running on ws://localhost:${PORT}`);
});