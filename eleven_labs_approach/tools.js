

require('dotenv').config();
const express = require('express');
const axios = require('axios'); 

const app = express();
const port = 4000; // Use a different port for your tools server
app.use(express.json()); // Middleware to parse JSON request bodies

// --- Dummy Data (replace with real database/API calls) ---
const orders = {
    '12345': { status: 'shipped', eta: 'June 15, 2025' },
    '67890': { status: 'processing', eta: 'June 18, 2025' },
};

// --- Webhook Endpoint for 'check_order_status' Tool ---
app.post('/elevenlabs/tool/check_order_status', async (req, res) => {
    console.log('Received tool call for check_order_status:', req.body);

    const { order_id } = req.body; 

    let responseToElevenLabs = {};

    console.log(`Checking status for order ID: ${order_id}`);

    if (order_id && orders[order_id]) {
        const order = orders[order_id];
        responseToElevenLabs = {
            status: 'success',
            data: {
                order_id: order_id,
                order_status: order.status,
                estimated_delivery: order.eta,
            },
            message: `Order ${order_id} is ${order.status} and estimated delivery is ${order.eta}.`
        };
    } else {
        responseToElevenLabs = {
            status: 'error',
            message: 'Order ID not found or invalid. Please provide a valid order ID.'
        };
    }

    // Eleven Labs expects a JSON response
    res.json(responseToElevenLabs);
});

// --- Start the Express server for tools ---
app.listen(port, () => {
    console.log(`Eleven Labs Tool server listening at http://localhost:${port}`);
    console.log(`Remember to use ngrok to expose this port for Eleven Labs webhook calls!`);
    console.log(`Example ngrok command: ngrok http ${port}`);
});