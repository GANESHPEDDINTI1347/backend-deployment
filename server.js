const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const bcrypt = require("bcrypt");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const { Pool } = require("pg");

require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* ---------- File Upload ---------- */
const upload = multer({ dest: "uploads/" });

/* ---------- PostgreSQL ---------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

/* ---------- DB Test ---------- */
pool.query("SELECT NOW()")
  .then(() => console.log("✅ PostgreSQL Connected"))
  .catch(err => console.error("❌ DB ERROR:", err));

/* ---------- DB Init ---------- */
async function initDB() {
  let client;
  try {
    client = await pool.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        name TEXT,
        phone TEXT,
        email TEXT,
        parentname TEXT,
        parentphone TEXT,
        year TEXT,
        aadhaar TEXT,
        address TEXT,
        attendance TEXT,
        marks TEXT DEFAULT '{}'
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT,
        studentid INTEGER
      );
    `);

    const hashedAdmin = await bcrypt.hash("admin123", 10);

    await client.query(
      `INSERT INTO users(username,password,role,studentid)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(username) DO NOTHING`,
      ["admin", hashedAdmin, "admin", 0]
    );

    console.log("✅ DB Initialized");

  } catch (err) {
    console.error("❌ DB INIT ERROR:", err);
  } finally {
    if (client) client.release();
  }
}
initDB();

/* ---------- LOGIN ---------- */
app.post("/login", async (req, res) => {
  try {
    const username = req.body.username.trim().toLowerCase();
    const password = req.body.password;

    const result = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );

    if (!result.rows.length)
      return res.json({ success: false });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);

    if (!valid)
      return res.json({ success: false });

    res.json({ success: true, user });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

/* ---------- REGISTER ---------- */
app.post("/register", async (req, res) => {
  try {
    const { name, username, password } = req.body;

    const check = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username.toLowerCase()]
    );

    if (check.rows.length > 0) {
      return res.json({ success: false, message: "User exists" });
    }

    const hashed = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO users(username,password,role,studentid) VALUES($1,$2,$3,$4)",
      [username.toLowerCase(), hashed, "student", null]
    );

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

/* ---------- CREATE STAFF ---------- */
app.post("/createStaff", async (req, res) => {
  try {
    const { username, password } = req.body;

    const check = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username.toLowerCase()]
    );

    if (check.rows.length > 0) {
      return res.json({ message: "User already exists" });
    }

    const hashed = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO users(username,password,role,studentid) VALUES($1,$2,$3,$4)",
      [username.toLowerCase(), hashed, "staff", null]
    );

    res.json({ message: "Staff created successfully" });

  } catch (err) {
    console.error(err);
    res.json({ message: "Error creating staff" });
  }
});

/* ---------- UPDATE STUDENT ---------- */
app.post("/updateByUsername", async (req, res) => {
  try {
    const { username, attendance, subject, marks } = req.body;

    const student = await pool.query(
      "SELECT * FROM students WHERE username=$1",
      [username.toLowerCase()]
    );

    if (!student.rows.length) {
      return res.json({ message: "Student not found" });
    }

    let currentMarks = student.rows[0].marks || "{}";
    currentMarks = JSON.parse(currentMarks);

    if (subject && marks) {
      currentMarks[subject] = marks;
    }

    await pool.query(
      `UPDATE students
       SET attendance=$1, marks=$2
       WHERE username=$3`,
      [
        attendance || student.rows[0].attendance,
        JSON.stringify(currentMarks),
        username.toLowerCase()
      ]
    );

    res.json({ message: "Student updated successfully" });

  } catch (err) {
    console.error(err);
    res.json({ message: "Update failed" });
  }
});

/* ---------- DELETE STUDENT ---------- */
app.delete("/deleteStudent/:id", async (req, res) => {
  try {
    const id = req.params.id;

    await pool.query("DELETE FROM students WHERE id=$1", [id]);
    await pool.query("DELETE FROM users WHERE studentid=$1", [id]);

    res.json({ message: "Student deleted" });

  } catch (err) {
    console.error(err);
    res.json({ message: "Delete failed" });
  }
});

/* ---------- GET STUDENTS ---------- */
app.get("/students", async (req, res) => {
  const result = await pool.query("SELECT * FROM students");
  res.json(result.rows);
});

/* ---------- GET SINGLE STUDENT ---------- */
app.get("/student/:id", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM students WHERE id=$1",
    [req.params.id]
  );
  res.json(result.rows[0]);
});

/* ---------- ADMIN STATS ---------- */
app.get("/adminStats", async (req, res) => {
  const students = await pool.query("SELECT COUNT(*) FROM students");
  const staff = await pool.query(
    "SELECT COUNT(*) FROM users WHERE role='staff'"
  );

  const attendance = await pool.query(
    "SELECT AVG(CAST(attendance AS INTEGER)) FROM students"
  );

  res.json({
    totalStudents: students.rows[0].count,
    totalStaff: staff.rows[0].count,
    avgAttendance: Math.round(attendance.rows[0].avg || 0)
  });
});

/* ---------- SERVER ---------- */
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});