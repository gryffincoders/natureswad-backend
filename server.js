// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// 2. Connect to MongoDB Atlas (Production Ready)
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log(' Connected to MongoDB Atlas!'))
  .catch((err) => console.error(' MongoDB connection error:', err));

// 3. Define the Order Schema
const orderSchema = new mongoose.Schema({
  userId: String,
  total: Number,
  items: Array,
  address: Object,
  paymentMethod: String,
  status: String,
  razorpay_order_id: String,
  razorpay_payment_id: String,
  createdAt: { type: Date, default: Date.now }
});

const Order = mongoose.model('Order', orderSchema);

// --- API ENDPOINTS ---

app.post('/api/create-razorpay-order', async (req, res) => {
  try {
    const options = {
      amount: Math.round(req.body.amount * 100),
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
    };
    const order = await razorpay.orders.create(options);
    res.json({ orderId: order.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/verify-and-save-order', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderDetails } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature." });
    }

    const newOrder = new Order({
      ...orderDetails,
      razorpay_order_id,
      razorpay_payment_id,
      status: "Paid",
    });

    const savedOrder = await newOrder.save();
    res.json({ success: true, orderId: savedOrder._id });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/place-cod-order', async (req, res) => {
  try {
    const newOrder = new Order({
      ...req.body.orderDetails,
      status: "Pending (COD)",
    });

    const savedOrder = await newOrder.save();
    res.json({ success: true, orderId: savedOrder._id });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/orders/:userId', async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.params.userId })
      .sort({ createdAt: -1 });

    res.json(orders);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// IMPORTANT FOR RENDER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(` Server running on port ${PORT}`);
});
