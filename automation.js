import { chromium } from 'playwright';
import minimist from 'minimist';
import path from 'path';

const args = minimist(process.argv.slice(2));

const {
  requestId,
  firstName,
  middleName,
  surname,
  idNumber,
  dateOfBirth,
  districtOfBirth,
  mobileNumber,
  email,
  pdfPath
} = args;

// Function to report progress to parent process
const sendProgress = (percentage) => {
  console.log(`PROGRESS:${percentage}`);
};

(async () => {
  try {
    // Start the automation process
    sendProgress(10);

    // Explicitly set headless mode for cloud environment
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    sendProgress(20);

    // Navigate to the NSSF registration page
    await page.goto('https://eservice.nssfkenya.co.ke/eApplicationMember/faces/newUser.xhtml');
    sendProgress(25);

    // Fill in the login credentials
    await page.getByRole('textbox', { name: 'Username:' }).fill(idNumber);
    await page.getByRole('textbox', { name: 'Password:', exact: true }).fill(idNumber);
    await page.getByRole('textbox', { name: 'Verify Password:' }).fill(idNumber);
    await page.getByRole('textbox', { name: 'ID No:' }).fill(idNumber);
    sendProgress(30);

    // Select ID document type
    await page.getByRole('row', { name: 'ID Document Type:* Please' }).locator('span').click();
    await page.locator('#idDocType_panel').getByText('National Identity Card').click();
    sendProgress(35);

    // Fill nationality and country of birth
    await page.getByRole('textbox', { name: 'Nationality:' }).fill('4.24');
    await page.getByRole('textbox', { name: 'Country of Birth:' }).fill('4.24');
    sendProgress(40);

    // Fill personal details
    await page.getByRole('textbox', { name: 'First Name:' }).fill(firstName);
    await page.getByRole('textbox', { name: 'Surname:' }).fill(surname);
    await page.getByRole('textbox', { name: 'Middle Name:' }).fill(middleName);
    sendProgress(45);

    // Select gender and fill DOB
    await page.locator('td:nth-child(3) > .ui-radiobutton > .ui-radiobutton-box').first().click();
    await page.getByRole('textbox', { name: 'Date of Birth:' }).fill(dateOfBirth);
    sendProgress(50);

    // Select voluntary flag
    await page.locator('#voluntaryFlg > tbody > tr > td:nth-child(3) > .ui-radiobutton > .ui-radiobutton-box').click();
    sendProgress(55);

    // Fill address details
    await page.getByRole('textbox', { name: 'P.O. Address 1:' }).fill('Nairobi,Kenya');
    await page.locator('#postalCode').fill('00100');
    sendProgress(60);

    // Fill contact details
    await page.getByRole('textbox', { name: 'Telephone:' }).fill(mobileNumber);
    await page.getByRole('textbox', { name: 'Email:' }).fill(email);
    sendProgress(65);

    // Fill location details
    await page.getByRole('textbox', { name: 'County:' }).fill('1.01');
    await page.getByRole('textbox', { name: 'District:' }).fill('Nairobi');
    await page.getByRole('textbox', { name: 'Location:' }).fill('Nairobi');
    await page.getByRole('textbox', { name: 'District of Birth:' }).fill(districtOfBirth);
    sendProgress(70);

    // Handle CAPTCHA and submit
    await page.locator('#CaptchaID').click();
    sendProgress(75);

    // Wait for CAPTCHA to be filled manually (in a real scenario)
    // For demo purposes, we'll just wait
    await page.waitForTimeout(10000);
    sendProgress(80);

    // Click save button
    await page.getByRole('button', { name: 'Save' }).click();
    sendProgress(85);

    // Wait for confirmation
    await page.waitForSelector('#locationSelector2');
    sendProgress(90);

    // Generate PDF
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
    });
    sendProgress(95);

    // Clean up
    await context.close();
    await browser.close();
    sendProgress(100);

    console.log(`PDF generated successfully at ${pdfPath}`);
    process.exit(0);
  } catch (error) {
    console.error('Automation failed:', error);
    process.exit(1);
  }
})();