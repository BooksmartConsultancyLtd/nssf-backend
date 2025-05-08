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

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('id');
  
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

app.post('/api/submit-form', upload.none(), async (req, res) => {
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
    const pdfFileName = `NSSF_${idNumber}_${requestId}.pdf`;
    const pdfPath = path.join(outDir, pdfFileName);

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
      if (output.startsWith('PROGRESS:')) {
        const percentage = parseInt(output.split(':')[1], 10);
        sendProgress(requestId, 'processing', percentage);
      }
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
        fs.unlink(pdfPath, () => {});
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

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server running on ws://localhost:${PORT}`);
});