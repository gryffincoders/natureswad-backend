// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB Atlas!'))
  .catch((err) => console.error('MongoDB connection error:', err));

const orderSchema = new mongoose.Schema({
  userId: String,
  subtotal: Number,
  discountApplied: Number,
  pointsRedeemed: Number,
  pointsEarned: Number,
  total: Number,
  items: Array,
  address: Object,
  paymentMethod: String,
  status: { type: String, default: "Placed" }, 
  razorpay_order_id: String,
  razorpay_payment_id: String,
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

// ✅ FIX: DYNAMIC RE-CALCULATION BLOCK PREVENTS STRANDED OR DELETED CONTEXT POINTS
const calculateDynamicPoints = async (identifier) => {
  if (!identifier || identifier === 'guest') return 0;

  // Query all active orders tied to this UID or contact number
  const activeOrders = await Order.find({
    $or: [
      { userId: identifier },
      { "address.phone": identifier }
    ]
  });

  let totalPoints = 0;
  activeOrders.forEach(order => {
    totalPoints += (order.pointsEarned || 0);
    totalPoints -= (order.pointsRedeemed || 0);
  });

  return Math.max(0, totalPoints); // Never allow negative points tracking anomalies
};

// ✅ FIX: ENFORCED DYNAMIC REAL-TIME AGGREGATION TO IGNORE DELETED ORDERS
app.get('/api/user-points/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const currentActivePoints = await calculateDynamicPoints(uid);
    res.json({ points: currentActivePoints });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

    // Safety structural validation check for balance thresholds before writing
    const userCurrentBalance = await calculateDynamicPoints(orderDetails.userId);
    if (orderDetails.pointsRedeemed > 0 && userCurrentBalance < orderDetails.pointsRedeemed) {
      return res.status(400).json({ error: "Insufficient rewards points threshold balance available." });
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
    const { orderDetails } = req.body;

    const userCurrentBalance = await calculateDynamicPoints(orderDetails.userId);
    if (orderDetails.pointsRedeemed > 0 && userCurrentBalance < orderDetails.pointsRedeemed) {
      return res.status(400).json({ error: "Insufficient rewards points threshold balance available." });
    }

    const newOrder = new Order({
      ...orderDetails,
      status: "Pending (COD)", 
    });

    const savedOrder = await newOrder.save();
    res.json({ success: true, orderId: savedOrder._id });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/orders/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;

    const orders = await Order.find({
      $or: [
        { userId: identifier },
        { "address.phone": identifier } 
      ]
    }).sort({ createdAt: -1 });

    res.json(orders);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/orders', async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.status(200).json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;

    const updatedOrder = await Order.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!updatedOrder) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.status(200).json(updatedOrder);
  } catch (error) {
    console.error("STATUS UPDATE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ ADDED AN EXPLICIT DELETE ROUTE FOR TESTING OR CANCELLATIONS TO PROVE SYNC
app.delete('/api/orders/:id', async (req, res) => {
  try {
    const deletedOrder = await Order.findByIdAndDelete(req.params.id);
    if (!deletedOrder) return res.status(404).json({ error: "Order context missing." });
    res.json({ success: true, message: "Order removed. Associated tracking points recalculated." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});