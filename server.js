const bcrypt = require("bcrypt");
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { Pool } = require("pg");
const csv = require("csv-parser");
const multer = require("multer");
const fs = require("fs");

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("../frontend"));

/* ---------- PostgreSQL Setup ---------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});


pool.query("SELECT NOW()")
  .then(() => console.log("✅ Database connected"))
  .catch(err => console.error("❌ DB connection failed:", err));

/* ---------- DB Init ---------- */
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        name TEXT,
        attendance TEXT,
        marks TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT,
        studentid INTEGER
      );
    `);

    const hashedAdmin = await bcrypt.hash("admin123", 10);

    await pool.query(
      `INSERT INTO users (username,password,role,studentid)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (username) DO NOTHING`,
      ["admin", hashedAdmin, "admin", 0]
    );

    console.log("✅ PostgreSQL ready");
  } catch (err) {
    console.error("DB Init Error:", err);
  }
}

initDB();

/* ---------- Upload CSV ---------- */
const upload = multer({ dest: "uploads/" });

app.post("/uploadStudents", upload.single("file"), async (req, res) => {
  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", data => results.push(data))
    .on("end", async () => {
      try {
        for (const s of results) {
          const student = await pool.query(
            "INSERT INTO students (name,attendance,marks) VALUES ($1,$2,$3) RETURNING id",
            [s.name, "0%", "{}"]
          );

          const studentId = student.rows[0].id;
          const hashedPassword = await bcrypt.hash(s.password, 10);

          await pool.query(
            "INSERT INTO users (username,password,role,studentid) VALUES ($1,$2,$3,$4)",
            [s.username, hashedPassword, "student", studentId]
          );
        }

        res.json({ message: "Students uploaded" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Upload failed" });
      }
    });
});

/* ---------- Login ---------- */
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );

    if (result.rows.length === 0)
      return res.json({ success: false });

    const user = result.rows[0];

    const valid = await bcrypt.compare(password, user.password);

    if (!valid)
      return res.json({ success: false });

    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

/* ---------- Register ---------- */
app.post("/register", async (req, res) => {
  try {
    const { name, username, password } = req.body;

    const studentRes = await pool.query(
      "INSERT INTO students(name,attendance,marks) VALUES($1,$2,$3) RETURNING id",
      [name, "0%", "{}"]
    );

    const studentId = studentRes.rows[0].id;
    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO users(username,password,role,studentid) VALUES($1,$2,$3,$4)",
      [username, hashedPassword, "student", studentId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "User exists" });
  }
});

/* ---------- Get Student ---------- */
app.get("/student/:id", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM students WHERE id=$1",
    [req.params.id]
  );

  if (!result.rows.length) return res.json(null);

  const student = result.rows[0];
  student.marks = JSON.parse(student.marks || "{}");

  res.json(student);
});

/* ---------- Update Student ---------- */
app.post("/updateByUsername", async (req, res) => {
  try {
    const { username, attendance, subject, marks } = req.body;

    const user = await pool.query(
      "SELECT studentid FROM users WHERE username=$1",
      [username]
    );

    if (!user.rows.length)
      return res.json({ message: "User not found" });

    const studentId = user.rows[0].studentid;

    const student = await pool.query(
      "SELECT marks FROM students WHERE id=$1",
      [studentId]
    );

    let marksObj = JSON.parse(student.rows[0].marks || "{}");

    if (subject && marks !== undefined)
      marksObj[subject] = marks;

    await pool.query(
      "UPDATE students SET attendance=$1, marks=$2 WHERE id=$3",
      [attendance, JSON.stringify(marksObj), studentId]
    );

    res.json({ message: "Updated successfully" });
  } catch (err) {
    console.error(err);
    res.json({ message: "Update failed" });
  }
});

/* ---------- Get Students ---------- */
app.get("/students", async (req, res) => {
  const result = await pool.query("SELECT * FROM students");

  result.rows.forEach(r => {
    r.marks = JSON.parse(r.marks || "{}");
  });

  res.json(result.rows);
});

/* ---------- Admin Stats ---------- */
app.get("/adminStats", async (req, res) => {
  const s = await pool.query("SELECT COUNT(*) FROM students");
  const st = await pool.query(
    "SELECT COUNT(*) FROM users WHERE role='staff'"
  );

  const rows = await pool.query("SELECT attendance FROM students");

  let sum = 0;
  rows.rows.forEach(r => {
    sum += parseInt(r.attendance || "0");
  });

  const avg =
    rows.rows.length > 0
      ? Math.round(sum / rows.rows.length)
      : 0;

  res.json({
    totalStudents: s.rows[0].count,
    totalStaff: st.rows[0].count,
    avgAttendance: avg,
  });
});

/* ---------- Delete Student ---------- */
app.delete("/deleteStudent/:id", async (req, res) => {
  const id = req.params.id;

  await pool.query("DELETE FROM students WHERE id=$1", [id]);
  await pool.query("DELETE FROM users WHERE studentid=$1", [id]);

  res.json({ message: "Deleted successfully" });
});

/* ---------- Test ---------- */
app.get("/test", (req, res) => res.send("Server OK"));

/* ---------- Server ---------- */
app.listen(5000, () =>
  console.log("🚀 Server running on port 5000")
);
