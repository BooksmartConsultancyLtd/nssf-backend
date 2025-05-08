import { chromium } from 'playwright';
import minimist from 'minimist';
import path from 'path';
import os from 'os';
import fs from 'fs';

const args = minimist(process.argv.slice(2));

// Extract values from arguments and ensure they are all strings to prevent Playwright fill errors
const {
  requestId = '',
  firstName = '',
  middleName = '',
  surname = '',
  idNumber = '',
  dateOfBirth = '',
  districtOfBirth = '',
  mobileNumber = '',
  email = '',
  pdfPath: providedPdfPath = ''
} = args;

// Ensure all values are strings
const formValues = {
  requestId: String(requestId),
  firstName: String(firstName),
  middleName: middleName ? String(middleName) : '',
  surname: String(surname),
  idNumber: String(idNumber),
  dateOfBirth: String(dateOfBirth),
  districtOfBirth: districtOfBirth ? String(districtOfBirth) : '',
  mobileNumber: String(mobileNumber),
  email: String(email)
};

// Helper function to send progress updates
const sendProgress = (percentage, data = null, status = 'processing') => {
  // Never include large data (like CAPTCHA images) in the JSON message directly
  // This prevents JSON parsing errors

  // Special handling for CAPTCHA images - never include in the JSON
  if (data && data.captchaImage) {
    // First send a regular progress update
    const message = {
      progress: parseInt(percentage),
      status: status
    };
    console.log(`PROGRESS:${JSON.stringify(message)}`);

    // Then send the CAPTCHA image separately
    // This avoids JSON parsing issues
    console.log(`CAPTCHA_BASE64_LENGTH:${data.captchaImage.length}`);
    console.log(`CAPTCHA_READY:${data.captchaImage}`);
    return;
  }

  // Normal progress updates
  const message = {
    progress: parseInt(percentage),
    status: percentage === 100 ? 'complete' : status
  };
  if (data) {
    message.data = data;
  }
  console.log(`PROGRESS:${JSON.stringify(message)}`);
};

// Function to refresh and capture CAPTCHA image
const captureCaptcha = async (page, shouldRefresh = false) => {
  try {
    console.log('Attempting to capture CAPTCHA image...');
    let captchaImg;

    if (shouldRefresh) {
      console.log('Refreshing CAPTCHA...');
      try {
        // Click the CAPTCHA refresh button
        await page.locator('#CaptchaID_ReloadLink').click();
        // Wait for the new CAPTCHA to load
        await page.waitForTimeout(1000);
      } catch (refreshError) {
        console.error('Error clicking refresh button:', refreshError);
        // Try alternative refresh method
        await page.evaluate(() => {
          const refreshLink = document.querySelector('#CaptchaID_ReloadLink');
          if (refreshLink) refreshLink.click();
        });
        await page.waitForTimeout(1000);
      }
    }

    // First try direct screenshot of the CAPTCHA image
    try {
      captchaImg = await page.locator('#CaptchaImgID').screenshot();
      console.log('Successfully captured CAPTCHA using direct ID selector');
    } catch (error) {
      console.log('Failed to capture CAPTCHA with direct ID:', error.message);

      // Try alternate approaches
      try {
        captchaImg = await page.locator('img[alt*="CAPTCHA"], img[alt*="captcha"], img[id*="Captcha"]').screenshot();
        console.log('Captured CAPTCHA using alternate selector');
      } catch (error2) {
        console.log('Failed with alternate selector:', error2.message);

        // Take a wider screenshot
        try {
          await page.locator('#CaptchaID').click();
          await page.waitForTimeout(500);

          captchaImg = await page.screenshot({
            clip: { x: 500, y: 400, width: 300, height: 100 }
          });
          console.log('Captured partial page screenshot around CAPTCHA area');
        } catch (error3) {
          console.log('Even partial screenshot failed:', error3.message);

          // Last resort - take the full page screenshot
          captchaImg = await page.screenshot();
          console.log('Using full page screenshot as last resort');
        }
      }
    }

    // Convert to base64 for transmission
    return captchaImg.toString('base64');
  } catch (error) {
    console.error('Error capturing CAPTCHA:', error);
    return null;
  }
};

(async () => {
  let browser;
  let context;
  let page;

  try {
    // Start the automation process
    sendProgress(10);

    // Format name for PDF path
    const fullName = `${formValues.firstName} ${formValues.middleName} ${formValues.surname}`.trim();

    // Use provided path or generate default
    const downloadsPath = process.env.OUTPUT_DIR || path.join(os.homedir(), 'Downloads');
    const pdfPath = providedPdfPath || path.join(downloadsPath, `${fullName} - ${formValues.idNumber}.pdf`);

    // Ensure output directory exists
    const pdfDir = path.dirname(pdfPath);
    if (!fs.existsSync(pdfDir)) {
      fs.mkdirSync(pdfDir, { recursive: true });
    }

    // Create debug directory if it doesn't exist
    const debugDir = path.join(path.dirname(pdfPath), 'debug');
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }

    // Create error directory if it doesn't exist
    const errorDir = path.join(path.dirname(pdfPath), 'error');
    if (!fs.existsSync(errorDir)) {
      fs.mkdirSync(errorDir, { recursive: true });
    }

    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    context = await browser.newContext();
    page = await context.newPage();

    sendProgress(20);

    // Log what we're about to do for debug purposes
    console.log('About to navigate to NSSF page and fill form with data:');
    console.log('First Name:', formValues.firstName);
    console.log('Middle Name:', formValues.middleName);
    console.log('Surname:', formValues.surname);
    console.log('ID Number:', formValues.idNumber);
    console.log('Date of Birth:', formValues.dateOfBirth);

    // Navigate to the NSSF registration page
    await page.locator('body').click();
    await page.goto('https://eservice.nssfkenya.co.ke/eApplicationMember/faces/newUser.xhtml');
    sendProgress(25);

    // Fill in the form fields using your exact locators
    try {
      // Fill login credentials using your exact locators
      await page.getByRole('textbox', { name: 'Username:*' }).fill(formValues.idNumber);
      await page.getByRole('textbox', { name: 'Password:*', exact: true }).fill(formValues.idNumber);
      await page.getByRole('textbox', { name: 'Verify Password:*' }).fill(formValues.idNumber);
      await page.getByRole('textbox', { name: 'ID No:*' }).fill(formValues.idNumber);
      sendProgress(30);

      // Select ID document type
      await page.getByRole('row', { name: 'ID Document Type:* Please' }).locator('span').click();
      await page.locator('#idDocType_panel').getByText('National Identity Card').click();
      sendProgress(35);

      // Fill nationality and country of birth
      await page.getByRole('textbox', { name: 'Nationality:*' }).fill('4.24');
      await page.getByRole('textbox', { name: 'Country of Birth:*' }).fill('4.24');
      sendProgress(40);

      // Fill personal details
      await page.getByRole('textbox', { name: 'First Name:*' }).fill(formValues.firstName);
      await page.getByRole('textbox', { name: 'Surname:*' }).fill(formValues.surname);
      await page.getByRole('textbox', { name: 'Middle Name:' }).fill(formValues.middleName);
      sendProgress(45);

      // Select gender and fill DOB
      await page.locator('td:nth-child(3) > .ui-radiobutton > .ui-radiobutton-box').first().click();
      await page.getByRole('textbox', { name: 'Date of Birth:*' }).fill(formValues.dateOfBirth);
      sendProgress(50);

      // Select voluntary flag
      await page.locator('#voluntaryFlg > tbody > tr > td:nth-child(3) > .ui-radiobutton > .ui-radiobutton-box').click();
      sendProgress(55);

      // Fill address details
      await page.getByRole('textbox', { name: 'P.O. Address 1:*' }).fill('Nairobi,Kenya');
      await page.locator('#postalCode').fill('00100');
      sendProgress(60);

      // Fill contact details
      await page.getByRole('textbox', { name: 'Telephone:' }).fill(formValues.mobileNumber);
      await page.getByRole('textbox', { name: 'Email:' }).fill(formValues.email);

      // Fill additional location details - all values must be strings
      await page.getByRole('textbox', { name: 'County:*' }).fill('1.01');
      await page.getByRole('textbox', { name: 'District:*' }).fill('Nairobi');
      await page.getByRole('textbox', { name: 'Location:*' }).fill('Nairobi');
      await page.getByRole('textbox', { name: 'District of Birth:*' }).fill(formValues.districtOfBirth || 'Nairobi');
    } catch (error) {
      console.error('Error during form filling:', error);
      throw new Error(`Form filling failed: ${error.message}`);
    }
    sendProgress(65);

    // CAPTCHA handling
    try {
      // Click CAPTCHA field to ensure it's visible
      await page.locator('#CaptchaID').click();
      await page.waitForTimeout(1000); // Wait for field to be focused

      // Take a screenshot of the full form for debugging
      await page.screenshot({ path: path.join(debugDir, `debug_form_${formValues.requestId}.png`) });

      // Capture the CAPTCHA image and prepare to send it
      const captchaBase64 = await captureCaptcha(page);

      if (!captchaBase64) {
        throw new Error('Failed to capture CAPTCHA image');
      }

      // Output CAPTCHA length for better processing by server
      console.log(`CAPTCHA_BASE64_LENGTH:${captchaBase64.length}`);

      // Send CAPTCHA in two ways for reliability:
      // 1. Direct console output for legacy processing
      console.log('CAPTCHA_READY:' + captchaBase64);

      // 2. Structured progress format 
      // First send preparing status to alert client
      sendProgress(70, null, 'captcha_preparing');
      await page.waitForTimeout(100); // Small pause to ensure client gets message

      // Then send the actual CAPTCHA data
      sendProgress(70, { captchaImage: captchaBase64 }, 'captcha_ready');

      // Wait for CAPTCHA input or refresh request from parent process
      const captchaText = await new Promise((resolve) => {
        const dataHandler = async (data) => {
          const input = data.toString().trim();

          if (input === 'REFRESH_CAPTCHA') {
            console.log('Received request to refresh CAPTCHA');
            // Capture new CAPTCHA image with refresh
            const newCaptchaBase64 = await captureCaptcha(page, true);
            if (newCaptchaBase64) {
              // Output length for better server processing
              console.log(`CAPTCHA_BASE64_LENGTH:${newCaptchaBase64.length}`);

              // Send via direct console output
              console.log('CAPTCHA_READY:' + newCaptchaBase64);

              // Send via structured progress
              sendProgress(70, { captchaImage: newCaptchaBase64 }, 'captcha_ready');
            } else {
              console.error('Failed to refresh CAPTCHA');
            }
            return;
          }

          if (input.startsWith('CAPTCHA_TEXT:')) {
            const captchaValue = input.replace('CAPTCHA_TEXT:', '');
            console.log(`Received CAPTCHA text: "${captchaValue}"`);
            process.stdin.removeListener('data', dataHandler);
            resolve(captchaValue);
          }
        };

        process.stdin.on('data', dataHandler);
      });

      console.log('Filling CAPTCHA field with:', captchaText);

      // Fill in the CAPTCHA text
      try {
        await page.locator('#CaptchaID').fill(captchaText);
        console.log('Successfully filled CAPTCHA field');
      } catch (fillError) {
        console.error('Error filling CAPTCHA field:', fillError);
        // Try an alternative approach
        try {
          await page.evaluate((text) => {
            const captchaInput = document.querySelector('#CaptchaID');
            if (captchaInput) {
              captchaInput.value = text;
            }
          }, captchaText);
          console.log('Filled CAPTCHA using JavaScript evaluation');
        } catch (jsError) {
          console.error('Even JavaScript CAPTCHA fill failed:', jsError);
          throw new Error('Failed to fill CAPTCHA field');
        }
      }

      sendProgress(75);

      // Click Save button
      console.log('Clicking Save button...');
      await page.getByRole('button', { name: 'Save' }).click();
      console.log('Save button clicked');

      // Wait for navigation to complete or error message
      console.log('Waiting for navigation after CAPTCHA submission...');
      try {
        // Wait for either success (locationSelector2) or error message
        const result = await Promise.race([
          page.waitForSelector('#locationSelector2', { timeout: 30000 }),
          page.waitForSelector('.ui-messages-error', { timeout: 30000 })
        ]);

        // Check if we got an error message
        if ((await result.evaluate(el => el.className)).includes('ui-messages-error')) {
          const errorText = await result.textContent();
          if (errorText.includes('User already exists')) {
            throw new Error('Registration failed: User already exists with these details');
          }
          throw new Error(`Form submission failed: ${errorText}`);
        }

        console.log('Successfully navigated to next page after CAPTCHA');
      } catch (navError) {
        console.error('Navigation error after CAPTCHA:', navError);

        // Check if we're still on the form page
        const onFormPage = await page.locator('#CaptchaID').count() > 0;
        if (onFormPage) {
          const errorMessages = await page.locator('.ui-messages-error').allTextContents();
          if (errorMessages.length > 0) {
            // Check specifically for 'User already exists' message
            if (errorMessages.some(msg => msg.includes('User already exists'))) {
              throw new Error('Registration failed: User already exists with these details');
            }
            throw new Error(`Form submission failed: ${errorMessages.join(', ')}`);
          } else {
            throw new Error('Form submission failed: Still on form page after clicking Save');
          }
        } else {
          // If we're on a different page but not the expected one, take a screenshot
          await page.screenshot({ path: path.join(errorDir, `error_page_${formValues.requestId}.png`) });
          throw new Error('Navigation failed: Could not find expected element after CAPTCHA submission');
        }
      }

      sendProgress(90);

      // Generate PDF with your exact settings
      console.log('Generating PDF...');
      await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true, // Enable background graphics
        margin: {
          top: '10mm',
          right: '10mm',
          bottom: '10mm',
          left: '10mm'
        }
      });

      const pdfFilename = path.basename(pdfPath);

      // Send progress with PDF download URL
      console.log(`PDF has been saved successfully at: ${pdfPath}`);
      const downloadUrl = `/download-pdf/${pdfFilename}`;

      // Even simpler approach to avoid all JSON parsing issues
      // Send progress update first
      console.log('PROGRESS:{"progress":100,"status":"complete"}');

      // Then send the PDF URL separately to avoid any JSON parsing issues
      console.log(`PDF_URL:${downloadUrl}`);

      // Add an explicit completion marker
      console.log('REGISTRATION_COMPLETE');

    } catch (error) {
      console.error('Error in CAPTCHA handling:', error);
      throw error;
    }

    console.log('NSSF Registration completed successfully!');
    return { success: true, message: 'Registration completed successfully', pdfPath };
  } catch (error) {
    console.error('Automation failed:', error);

    // Take a screenshot of the error state
    if (page) {
      try {
        const errorScreenshotPath = path.join(path.dirname(providedPdfPath), 'error', `error_${formValues.requestId}_${Date.now()}.png`);
        await page.screenshot({ path: errorScreenshotPath, fullPage: true });
        console.log(`Error screenshot saved to: ${errorScreenshotPath}`);
      } catch (screenshotError) {
        console.error('Failed to take error screenshot:', screenshotError);
      }
    }

    // Send error to parent process through stderr
    console.error(error.message);

    // Also send error via progress channel
    sendProgress(0, { error: error.message }, 'error');

    process.exit(1);
  } finally {
    // Clean up
    if (context) await context.close().catch(e => console.error('Error closing context:', e));
    if (browser) await browser.close().catch(e => console.error('Error closing browser:', e));
  }
})();