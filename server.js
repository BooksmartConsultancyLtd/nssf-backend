import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { fileURLToPath } from 'url';

// Define __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure multer for form data
const upload = multer();

// Create Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3001;

// Store WebSocket connections with their IDs
const clients = new Map();

// Store automation processes and their stdin streams
const automationProcesses = new Map();
const automationStdins = new Map();

// Store CAPTCHA images by request ID
const captchaImages = new Map();

// Enable CORS for all routes
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204
}));

// Configure middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve PDF files
app.get('/download-pdf/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(tmpDir, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, message: 'PDF not found' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    fs.createReadStream(filePath).pipe(res);
});

// Create uploads directory if it doesn't exist
const tmpDir = process.env.OUTPUT_DIR || path.join(__dirname, 'tmp');
const debugDir = path.join(__dirname, 'debug');
const errorDir = path.join(__dirname, 'error');

// Ensure all required directories exist
for (const dir of [tmpDir, debugDir, errorDir]) {
    if (!fs.existsSync(dir)) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`Created directory: ${dir}`);
        } catch (err) {
            console.error(`Failed to create directory ${dir}:`, err);
        }
    }
}

// Configure routes

// Simple health check
app.get('/', (req, res) => {
    res.json({ status: 'NSSF Registration API is running' });
});

// Detailed health check
app.get('/health', (req, res) => {
    const connectedClients = Array.from(clients.keys());

    res.json({
        status: 'ok',
        message: 'Server is running',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        clientsConnected: connectedClients.length,
        memoryUsage: process.memoryUsage()
    });
});

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    let id;

    try {
        // Extract ID from query parameters
        let url;

        if (req.url.startsWith('/?id=')) {
            // Local WebSocket URL format
            url = new URL(`http://localhost${req.url}`);
        } else {
            // Full WebSocket URL
            url = new URL(req.url, 'http://localhost');
        }

        id = url.searchParams.get('id');

        if (!id) {
            // Try regex as fallback
            const match = req.url.match(/[?&]id=([^&]+)/);
            id = match ? match[1] : null;
        }
    } catch (error) {
        console.error('Error parsing WebSocket URL:', error);
        id = null;
    }

    if (id) {
        // Store the WebSocket connection
        clients.set(id, ws);
        console.log(`WebSocket client connected with ID: ${id}`);

        // Send initial connection confirmation
        ws.send(JSON.stringify({
            status: 'connected',
            message: 'WebSocket connection established',
            requestId: id,
            timestamp: Date.now()
        }));
    } else {
        console.error('WebSocket connection without ID');
        ws.close(1000, 'Missing ID parameter');
    }

    // Handle WebSocket messages from the client
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`Received WebSocket message from client ${id}:`, data);

            // Handle ping/pong heartbeat
            if (data.type === 'ping') {
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: Date.now()
                }));
                return;
            }

            if (data.type === 'captcha') {
                storeCaptchaInput(data.requestId, data.captchaText);
            } else if (data.type === 'refresh_captcha') {
                // Send refresh command to automation process
                const stdin = automationStdins.get(data.requestId);
                if (stdin) {
                    stdin.write('REFRESH_CAPTCHA\n');
                    console.log(`Sent CAPTCHA refresh request for ${data.requestId}`);
                } else {
                    console.error(`No automation process stdin found for ${data.requestId}`);
                    ws.send(JSON.stringify({
                        status: 'error',
                        message: 'Cannot refresh CAPTCHA - process not found'
                    }));
                }
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
        }
    });

    // Handle WebSocket closure
    ws.on('close', () => {
        if (id) {
            clients.delete(id);
            console.log(`WebSocket client disconnected: ${id}`);

            // Clean up any associated resources
            const process = automationProcesses.get(id);
            if (process) {
                console.log(`Terminating automation process for ${id}`);
                process.kill();
                automationProcesses.delete(id);
                automationStdins.delete(id);
            }
        }
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
        console.error(`WebSocket error for client ${id}:`, error);
    });
});

// Function to store CAPTCHA input from user and send to automation process
const storeCaptchaInput = (id, captchaText) => {
    console.log(`Received CAPTCHA input for ${id}: ${captchaText}`);

    // Send confirmation to the client
    const ws = clients.get(id);
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
            status: 'captcha_received',
            progress: 85,
            message: 'CAPTCHA received, continuing registration process'
        }));
    }

    // Send the CAPTCHA text to the automation process
    const stdin = automationStdins.get(id);
    if (stdin) {
        stdin.write(`CAPTCHA_TEXT:${captchaText}\n`);
        console.log(`Sent CAPTCHA text to automation process for ${id}`);
    } else {
        console.error(`No automation process stdin found for ${id}`);
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
                status: 'error',
                message: 'Failed to process CAPTCHA: Automation process not found'
            }));
        }
    }
};

// In server.js, modify the sendProgress function:

const sendProgress = async (id, status, progress, errorMessage = null, captchaImage = null, additionalData = {}) => {
    const ws = clients.get(id);

    if (!ws || ws.readyState !== 1) {
        console.error(`Cannot send progress update to ${id}: WebSocket not connected`);
        return;
    }

    try {
        // For CAPTCHA images, use a special dedicated mechanism to avoid JSON parsing issues
        if (status === 'captcha_ready' && captchaImage) {
            console.log(`Sending CAPTCHA image to ${id} (${captchaImage.length} bytes)`);

            // Store the CAPTCHA image in the map for polling fallback
            captchaImages.set(id, captchaImage);

            // First send a message without the image to alert the client
            ws.send(JSON.stringify({
                status: 'captcha_preparing',
                progress: progress,
                message: 'Preparing CAPTCHA verification',
                timestamp: Date.now()
            }));

            // Wait a short time to ensure the preparation message is processed
            await new Promise(resolve => setTimeout(resolve, 200));

            // Split the CAPTCHA image into chunks if it's very large
            // This avoids WebSocket message size limitations and JSON parsing issues
            const MAX_CHUNK_SIZE = 10000; // Adjust as needed
            
            if (captchaImage.length > MAX_CHUNK_SIZE) {
                // Send in chunks - first notify client we're sending chunks
                ws.send(JSON.stringify({
                    status: 'captcha_chunks_start',
                    progress: progress,
                    totalChunks: Math.ceil(captchaImage.length / MAX_CHUNK_SIZE),
                    timestamp: Date.now()
                }));
                
                // Send each chunk with a small delay between
                for (let i = 0; i < captchaImage.length; i += MAX_CHUNK_SIZE) {
                    const chunk = captchaImage.substring(i, i + MAX_CHUNK_SIZE);
                    const chunkNum = Math.floor(i / MAX_CHUNK_SIZE) + 1;
                    const isLastChunk = i + MAX_CHUNK_SIZE >= captchaImage.length;
                    
                    ws.send(JSON.stringify({
                        status: isLastChunk ? 'captcha_chunks_end' : 'captcha_chunk',
                        progress: progress,
                        chunkNum: chunkNum,
                        chunk: chunk,
                        timestamp: Date.now()
                    }));
                    
                    // Small delay between chunks
                    if (!isLastChunk) {
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                }
            } else {
                // Send the whole image in one message if it's small enough
                ws.send(JSON.stringify({
                    status: 'captcha_ready',
                    progress: progress,
                    captchaImage: captchaImage,
                    timestamp: Date.now()
                }));
            }
        } else {
            // For non-CAPTCHA updates, use the normal approach
            const baseMessage = {
                status: typeof status === 'string' ? status : (progress === 100 ? 'complete' : 'processing'),
                progress: parseInt(progress) || 0,
                message: errorMessage || `Processing ${progress}%`,
                timestamp: Date.now(),
                ...additionalData
            };
            
            // Send the message
            ws.send(JSON.stringify(baseMessage));
            
            // For completion messages, send a follow-up confirmation
            if (progress === 100 || status === 'complete') {
                setTimeout(() => {
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({
                            status: 'complete',
                            progress: 100,
                            message: 'Registration completed successfully',
                            timestamp: Date.now(),
                            ...additionalData
                        }));
                    }
                }, 500);
            }
            
            console.log(`Progress update sent to ${id}: ${status} ${progress}%`);
        }
    } catch (error) {
        console.error(`Error sending progress update to ${id}:`, error);
    }
};

// Handle form submission - support both API paths
app.post(['/api/submit-form', '/submit-form'], upload.none(), async (req, res) => {
    let requestId;

    try {
        // Log the incoming request
        console.log('Received form submission:', req.body);

        // Generate a unique request ID
        requestId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        console.log(`Generated request ID: ${requestId}`);

        // Validate required fields
        const {
            firstName,
            middleName,
            surname,
            idNumber,
            dateOfBirth,
            mobileNumber,
            email
        } = req.body;

        if (!firstName || !surname || !idNumber || !dateOfBirth || !mobileNumber || !email) {
            console.error('Missing required fields');
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Send immediate response to client with requestId
        res.json({
            success: true,
            message: 'Processing started',
            requestId
        });

        // Process in the background
        (async () => {
            try {
                // Generate a unique PDF output path
                const pdfFileName = `NSSF_${requestId}.pdf`;
                const pdfPath = path.join(tmpDir, pdfFileName);
                console.log(`PDF will be saved to: ${pdfPath}`);

                // Send initial progress update
                sendProgress(requestId, 'starting', 0);

                // Prepare arguments for automation script - ensure all values are strings
                const args = [
                    '--requestId', String(requestId),
                    '--firstName', String(firstName),
                    '--middleName', String(middleName || ''),
                    '--surname', String(surname),
                    '--idNumber', String(idNumber),
                    '--dateOfBirth', String(dateOfBirth),
                    '--districtOfBirth', String(req.body.districtOfBirth || ''),
                    '--mobileNumber', String(mobileNumber),
                    '--email', String(email),
                    '--pdfPath', pdfPath
                ];

                console.log(`Spawning automation process with args: ${args.join(' ')}`);

                // Get the absolute path to automation.js
                const automationScriptPath = path.resolve(__dirname, 'automation.js');

                // Spawn the process
                const child = spawn('node', [automationScriptPath, ...args], {
                    stdio: ['pipe', 'pipe', 'pipe'], // Use pipe for all channels
                    env: {
                        ...process.env,
                        OUTPUT_DIR: tmpDir
                    }
                });

                // Check if process was created successfully
                if (!child.pid) {
                    throw new Error('Failed to spawn automation process');
                }
                console.log(`Automation process spawned with PID: ${child.pid}`);

                // Store process and stdin references
                automationProcesses.set(requestId, child);
                automationStdins.set(requestId, child.stdin);

                // Use a buffer to concatenate potential multi-part CAPTCHA data
                let captchaBuffer = '';
                let isCaptchaMode = false;
                let expectedCaptchaLength = 0;

                // Process stdout
                child.stdout.on('data', (data) => {
                    const output = data.toString();
                    console.log(`Automation output for ${requestId}: ${output.substring(0, 500)}${output.length > 500 ? ' (truncated)' : ''}`);

                    // Check for PDF URL message - this is our new simplified approach
                    if (output.includes('PDF_URL:')) {
                        const pdfUrlMatch = output.match(/PDF_URL:([^\s]+)/);
                        if (pdfUrlMatch) {
                            const pdfUrl = pdfUrlMatch[1];
                            const pdfFileName = path.basename(pdfUrl);
                            const pdfPath = path.join(tmpDir, pdfFileName);
                            
                            console.log(`Found PDF URL: ${pdfUrl} for request ${requestId}`);
                            
                            // Verify the PDF exists
                            if (fs.existsSync(pdfPath)) {
                                console.log(`PDF file verified for ${requestId}: ${pdfFileName}`);
                                
                                // Send completion message with PDF URL
                                sendProgress(requestId, 'complete', 100, 'Registration completed successfully', null, {
                                    pdfAvailable: true,
                                    pdfUrl: pdfUrl,
                                    pdfFilename: pdfFileName
                                });
                            } else {
                                console.log(`PDF file not found yet at ${pdfPath}, will check again on completion`);
                            }
                        }
                    }
                    
                    // Check for explicit completion marker
                    if (output.includes('REGISTRATION_COMPLETE')) {
                        completionProcessed = true;
                        console.log(`Registration process completed for ${requestId}`);
                    }

                    // Check for progress updates (PROGRESS:{ ... })
                    let hasProcessedProgress = false;
                    
                    if (output.includes('PROGRESS:')) {
                        hasProcessedProgress = true;
                        
                        try {
                            // Simple extraction of the JSON part
                            const progressStart = output.indexOf('PROGRESS:') + 'PROGRESS:'.length;
                            let jsonStr = '';
                            
                            // Look for a complete JSON object
                            if (output.substring(progressStart).trim().startsWith('{')) {
                                // Find the end of the JSON object by counting braces
                                let braceCount = 0;
                                let inQuotes = false;
                                let escapeNext = false;
                                
                                for (let i = progressStart; i < output.length; i++) {
                                    const char = output[i];
                                    jsonStr += char;
                                    
                                    if (escapeNext) {
                                        escapeNext = false;
                                        continue;
                                    }
                                    
                                    if (char === '\\') {
                                        escapeNext = true;
                                        continue;
                                    }
                                    
                                    if (char === '"' && !escapeNext) {
                                        inQuotes = !inQuotes;
                                        continue;
                                    }
                                    
                                    if (!inQuotes) {
                                        if (char === '{') {
                                            braceCount++;
                                        } else if (char === '}') {
                                            braceCount--;
                                            if (braceCount === 0) {
                                                break;
                                            }
                                        }
                                    }
                                }
                                
                                // Try to parse the JSON
                                try {
                                    const progressData = JSON.parse(jsonStr);
                                    console.log(`Successfully parsed progress update for ${requestId}:`, progressData);
                                    
                                    // Extract progress and status

                                    // Send the progress update to the client
                                    console.log(`Sending progress update: ${progress}% to client ${requestId}`);
                                    sendProgress(requestId, status, progress, null, null, data || {});
                                    
                                    // Log success message
                                    console.log(`Progress update sent to ${requestId}: ${status} ${progress}%`);
                                } catch (jsonError) {
                                    console.error(`Failed to parse progress JSON for ${requestId}:`, jsonError);
                                    console.error(`Problematic JSON string: ${jsonStr}`);
                                }
                                }
                            
                        } catch (error) {
                            console.error(`Error parsing progress update for ${requestId}:`, error);
                        }
                    }
                    
                    // Handle CAPTCHA Base64 Length indicator
                    if (output.includes('CAPTCHA_BASE64_LENGTH:')) {
                        const lengthMatch = output.match(/CAPTCHA_BASE64_LENGTH:(\d+)/);
                        if (lengthMatch) {
                            expectedCaptchaLength = parseInt(lengthMatch[1]);
                            console.log(`Expecting CAPTCHA image of ${expectedCaptchaLength} bytes`);
                        }
                    }

                    // If we processed a progress update, don't process CAPTCHA in the same chunk
                    if (hasProcessedProgress) {
                        return;
                    }

                    // Check if we're starting CAPTCHA data
                    if (output.includes('CAPTCHA_READY:')) {
                        captchaBuffer = '';
                        isCaptchaMode = true;
                        
                        // Extract initial CAPTCHA data
                        const captchaStart = output.indexOf('CAPTCHA_READY:') + 'CAPTCHA_READY:'.length;
                        captchaBuffer += output.substring(captchaStart);
                        return;
                    }
                    
                    // If we're in CAPTCHA mode, keep appending data until we have a complete, valid base64 string
                    if (isCaptchaMode) {
                        captchaBuffer += output;
                        
                        // Check if we have a complete base64 string
                        const base64Match = captchaBuffer.match(/^([A-Za-z0-9+/=]+)/);
                        if (base64Match && base64Match[1].length > 1000) { // Minimal reasonable size
                            const captchaImage = base64Match[1];
                            isCaptchaMode = false;
                            
                            console.log(`Processed complete CAPTCHA image (${captchaImage.length} bytes)`);
                            
                            // Store in the captchaImages map for fallback polling
                            captchaImages.set(requestId, captchaImage);
                            
                            // Send to client via WebSocket
                            sendProgress(requestId, 'captcha_ready', 70, null, captchaImage);
                            captchaBuffer = ''; // Reset buffer
                            return;
                        }
                        
                        // If we have enough data or the expected length
                        if (expectedCaptchaLength > 0 && captchaBuffer.length >= expectedCaptchaLength) {
                            // Ensure we only capture valid base64 characters
                            const base64Regex = /^([A-Za-z0-9+/=]+)/;
                            const captchaMatch = captchaBuffer.match(base64Regex);
                            
                            if (captchaMatch) {
                                const captchaImage = captchaMatch[1];
                                isCaptchaMode = false;
                                
                                console.log(`Processed complete CAPTCHA image based on expected length (${captchaImage.length} bytes)`);
                                
                                // Store in the captchaImages map for fallback polling
                                captchaImages.set(requestId, captchaImage);
                                
                                // Send to client via WebSocket
                                sendProgress(requestId, 'captcha_ready', 70, null, captchaImage);
                                captchaBuffer = '';
                                expectedCaptchaLength = 0;
                                return;
                            }
                        }
                        
                        // If buffer gets too large without valid base64, reset
                        if (captchaBuffer.length > 200000) {
                            console.error('CAPTCHA buffer overflow, resetting');
                            captchaBuffer = '';
                            isCaptchaMode = false;
                            sendProgress(requestId, 'error', 0, 'Failed to process CAPTCHA image (buffer overflow)');
                        }
                    } // End of isCaptchaMode block
                });
                
                // Handle error output from stderr
                child.stderr.on('data', (data) => {
                    // Handle error output
                    const errorOutput = data.toString().trim();
                    console.error(`Automation error for ${requestId}: ${errorOutput}`);
                    
                    // Check for specific error messages
                    if (errorOutput.includes('User already exists')) {
                        sendProgress(requestId, 'error', 0, 'A member with this ID number is already registered with NSSF');
                    }
                });

                // Handle spawn errors
                child.on('error', (error) => {
                    console.error(`Automation process error for ${requestId}:`, error);
                    sendProgress(requestId, 'error', 0, error.message);
                });

                // Flag to track if we've already processed completion
                let completionProcessed = false;
                
                // Process exit handler
                child.on('exit', (code, signal) => {
                    console.log(`Automation process for ${requestId} exited with code ${code} and signal ${signal}`);

                    // Clean up resources
                    automationProcesses.delete(requestId);
                    automationStdins.delete(requestId);
                    
                    // Skip further processing if we've already handled completion
                    if (completionProcessed) {
                        console.log(`Skipping duplicate completion processing for ${requestId}`);
                        return;
                    }

                    if (code === 0) {
                        // Successful completion
                        const pdfFileName = `NSSF_${requestId}.pdf`;
                        const pdfUrl = `/download-pdf/${pdfFileName}`;
                        
                        // Check if PDF was generated
                        if (fs.existsSync(path.join(tmpDir, pdfFileName))) {
                            console.log(`PDF file exists for ${requestId}: ${pdfFileName}`);
                            console.log(`Sending final completion message with pdfUrl: ${pdfUrl}`);
                            
                            // Read the PDF file to ensure it's ready before sending completion
                            try {
                                const pdfData = fs.readFileSync(path.join(tmpDir, pdfFileName));
                                console.log(`Read PDF data for ${requestId}, size: ${pdfData.length} bytes`);
                                
                                // Mark as processed to avoid duplicate processing
                                completionProcessed = true;
                                
                                // Send a clear completion message with status='complete' and progress=100
                                sendProgress(requestId, 'complete', 100, 'Registration completed successfully', null, { pdfUrl });
                                
                                // Also send a direct WebSocket message as a backup
                                const ws = clients.get(requestId);
                                if (ws && ws.readyState === 1) {
                                    try {
                                        const completionMessage = JSON.stringify({
                                            status: 'complete',
                                            progress: 100,
                                            message: 'Registration completed successfully',
                                            data: { pdfUrl },
                                            timestamp: Date.now()
                                        });
                                        console.log(`Sending direct completion message: ${completionMessage}`);
                                        ws.send(completionMessage);
                                        
                                        // Keep the connection open for a moment to ensure the message is received
                                        setTimeout(() => {
                                            // Only close if still connected
                                            if (ws.readyState === 1) {
                                                console.log(`Closing WebSocket connection for ${requestId} after successful completion`);
                                                ws.close(1000, 'Registration completed successfully');
                                            }
                                        }, 2000); // Wait 2 seconds before closing
                                    } catch (wsError) {
                                        console.error(`Error sending direct completion message: ${wsError.message}`);
                                    }
                                }
                            } catch (pdfError) {
                                console.error(`Error reading PDF for ${requestId}:`, pdfError);
                                sendProgress(requestId, 'complete', 100, 'Registration completed but PDF may be incomplete', null, { pdfUrl });
                            }
                        } else {
                            console.error(`PDF file not found for ${requestId}`);
                            sendProgress(requestId, 'error', 0, 'Failed to generate registration document');
                        }
                    } else {
                        // Process failed
                        let errorMsg = 'Registration failed. Please try again.';
                        
                        // Check for specific error messages in the output
                        if (signal) {
                            errorMsg = 'The registration process was interrupted. Please try again.';
                        } else if (code === 1) {
                            // Check if there's a specific error message about user existing
                            const lastError = child.stderr?.read()?.toString() || '';
                            if (lastError.includes('User already exists')) {
                                errorMsg = 'A member with this ID number is already registered with NSSF';
                            }
                        }
                        
                        console.error(`Automation failed for ${requestId}: ${errorMsg}`);
                        sendProgress(requestId, 'error', 0, errorMsg);
                    }
                });
            } catch (error) {
                console.error(`Background processing error for ${requestId}:`, error);
                sendProgress(requestId, 'error', 0, error.message);
            }
        })();
    } catch (error) {
        console.error('Form submission error:', error);
        
        // Only send response if it hasn't been sent yet
        if (!res.headersSent) {
            res.status(500).json({ 
                success: false, 
                message: 'Server error',
                error: error.message 
            });
        }
    }
});

// Endpoint to receive CAPTCHA input from frontend
app.post('/submit-captcha', upload.none(), (req, res) => {
    try {
        const { requestId, captchaText } = req.body;
        
        if (!requestId || !captchaText) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing requestId or captchaText' 
            });
        }
        
        console.log(`Received CAPTCHA input via HTTP for ${requestId}: ${captchaText}`);
        
        // Store the CAPTCHA text and notify the automation process
        storeCaptchaInput(requestId, captchaText);
        
        res.json({ 
            success: true, 
            message: 'CAPTCHA received',
            requestId
        });
    } catch (error) {
        console.error('Error processing CAPTCHA:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to process CAPTCHA',
            error: error.message
        });
    }
});

// Poll status endpoint (fallback for WebSocket)
app.get(['/submit-form/status', '/api/submit-form/status'], (req, res) => {
    try {
        const { id } = req.query;
        
        if (!id) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing request ID' 
            });
        }
        
        // Check if we have a WebSocket connection for this request
        const wsClient = clients.get(id);
        
        // Check if automation process is still running
        const isProcessRunning = automationProcesses.has(id);
        
        // Check if we have a stored CAPTCHA image
        const captchaImage = captchaImages.get(id);
        
        // Check for generated PDF
        const pdfPath = path.join(tmpDir, `NSSF_${id}.pdf`);
        let pdfData = null;
        
        if (fs.existsSync(pdfPath)) {
            try {
                // Read the PDF file
                pdfData = fs.readFileSync(pdfPath, { encoding: 'base64' });
                console.log(`Read PDF data for ${id}, size: ${pdfData.length} bytes`);
            } catch (readError) {
                console.error(`Error reading PDF for ${id}:`, readError);
            }
        }
        
        // Determine current status
        let status = 'unknown';
        let progress = 0;
        
        if (pdfData) {
            status = 'complete';
            progress = 100;
        } else if (captchaImage) {
            status = 'captcha_ready';
            progress = 70;
        } else if (isProcessRunning) {
            status = 'processing';
            progress = 50;
        } else if (!wsClient && !isProcessRunning && !pdfData) {
            status = 'error';
            progress = 0;
        }
        
        // Prepare response
        const response = {
            success: true,
            status,
            progress,
            requestId: id
        };
        
        // Add PDF data if available
        if (pdfData) {
            response.pdfData = pdfData;
            response.pdfUrl = `/download-pdf/NSSF_${id}.pdf`;
        }
        
        // Add CAPTCHA image if available and no PDF yet
        if (captchaImage && !pdfData) {
            response.captchaImage = captchaImage;
        }
        
        res.json(response);
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to check status',
            error: error.message
        });
    }
});

// Download PDF endpoint
app.get('/download-pdf/:requestId', (req, res) => {
    try {
        const { requestId } = req.params;
        
        if (!requestId) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing request ID' 
            });
        }
        
        const pdfPath = path.join(tmpDir, `NSSF_${requestId}.pdf`);
        
        if (!fs.existsSync(pdfPath)) {
            return res.status(404).json({ 
                success: false, 
                message: 'PDF not found' 
            });
        }
        
        res.download(pdfPath, `NSSF_Registration_${requestId}.pdf`, (error) => {
            if (error) {
                console.error(`Error downloading PDF for ${requestId}:`, error);
                
                // Only send error response if headers haven't been sent
                if (!res.headersSent) {
                    res.status(500).json({ 
                        success: false, 
                        message: 'Failed to download PDF',
                        error: error.message
                    });
                }
            }
        });
    } catch (error) {
        console.error('PDF download error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to download PDF',
            error: error.message
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: err.message
    });
});

// Start server with improved error handling
const startServer = (port) => {
    const currentPort = port || PORT;
    
    // Verify the temporary directory before starting the server
    if (!fs.existsSync(tmpDir)) {
        console.error(`Temporary directory ${tmpDir} does not exist. Attempting to create it...`);
        try {
            fs.mkdirSync(tmpDir, { recursive: true });
            console.log(`Successfully created temporary directory: ${tmpDir}`);
        } catch (dirErr) {
            console.error(`CRITICAL ERROR: Could not create temporary directory: ${dirErr.message}`);
            console.error('The server cannot start without a valid temporary directory.');
            process.exit(1);
        }
    }
    
    server.listen(currentPort, () => {
        console.log(`=================================================`);
        console.log(`Server running on port ${currentPort}`);
        console.log(`WebSocket server running on ws://localhost:${currentPort}`);
        console.log(`API base URL: http://localhost:${currentPort}`);
        console.log(`Temporary directory: ${tmpDir}`);
        console.log(`Debug directory: ${debugDir}`);
        console.log(`Error directory: ${errorDir}`);
        console.log(`=================================================`);
        
        // Log memory usage
        const memUsage = process.memoryUsage();
        console.log('Memory usage:', {
            rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
            heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`
        });
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${currentPort} is already in use, trying port ${currentPort + 1}...`);
            startServer(currentPort + 1);
        } else {
            console.error('Server error:', err);
            console.error('The server failed to start. Please check the logs for more information.');
            process.exit(1);
        }
    });
    
    // Add global error handlers to prevent crashes
    process.on('uncaughtException', (error) => {
        console.error('UNCAUGHT EXCEPTION:', error);
        fs.writeFileSync(
            path.join(errorDir, `uncaught_${Date.now()}.log`),
            JSON.stringify({ error: error.stack || error.toString(), time: new Date().toISOString() }, null, 2)
        );
        // Don't exit the process, just log the error
    });
};

// Start the server with better logging
console.log('Starting NSSF Registration Automation server...');
try {
    startServer();
} catch (startupError) {
    console.error('Failed to start server:', startupError);
    process.exit(1);
}