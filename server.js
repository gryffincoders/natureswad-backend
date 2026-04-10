require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

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


const userSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true },
  points: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);


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



const handlePointsLogic = async (userId, pointsRedeemed, pointsEarned) => {
  if (!userId || userId === 'guest') return;

  let user = await User.findOne({ uid: userId });
  if (!user) {
    user = new User({ uid: userId, points: 0 });
  }

  
  if (pointsRedeemed > 0 && user.points < pointsRedeemed) {
    throw new Error("Insufficient points for redemption.");
  }

  user.points -= (pointsRedeemed || 0);
  user.points += (pointsEarned || 0);

  await user.save();
};


app.get('/api/user-points/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    if (uid === 'guest') return res.json({ points: 0 });

    let user = await User.findOne({ uid });
    if (!user) {
      
      user = await User.create({ uid, points: 0 });
    }

    res.json({ points: user.points });
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

  
    await handlePointsLogic(orderDetails.userId, orderDetails.pointsRedeemed, orderDetails.pointsEarned);

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

    
    await handlePointsLogic(orderDetails.userId, orderDetails.pointsRedeemed, orderDetails.pointsEarned);

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


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(` Server running on port ${PORT}`);
});