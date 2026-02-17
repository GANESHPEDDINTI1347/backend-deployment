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
  ssl: { rejectUnauthorized: false }
});

pool.query("SELECT NOW()")
  .then(() => console.log("✅ PostgreSQL ready"))
  .catch(console.error);

/* ---------- DB Init ---------- */
async function initDB() {
  const client = await pool.connect();

  try {
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

  } finally {
    client.release();
  }
}

initDB();

/* ---------- CSV Upload ---------- */
app.post("/uploadStudents", upload.single("file"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ message: "No file uploaded" });

  const rows = [];

  fs.createReadStream(req.file.path)
    .pipe(csv({
      mapHeaders: ({ header }) =>
        header.trim().toLowerCase().replace(/^\uFEFF/, "")
    }))
    .on("data", row => {
      const cleanRow = {};
      for (let key in row)
        cleanRow[key] = row[key]?.trim() || "";
      rows.push(cleanRow);
    })
    .on("end", async () => {
      try {
        let count = 0;

        for (const s of rows) {
          if (!s.username || !s.name) continue;

          const student = await pool.query(
            `INSERT INTO students
            (username,name,phone,email,parentname,parentphone,
             year,aadhaar,address,attendance,marks)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}')
             ON CONFLICT(username)
             DO UPDATE SET
               name=EXCLUDED.name,
               phone=EXCLUDED.phone,
               email=EXCLUDED.email,
               parentname=EXCLUDED.parentname,
               parentphone=EXCLUDED.parentphone,
               year=EXCLUDED.year,
               aadhaar=EXCLUDED.aadhaar,
               address=EXCLUDED.address,
               attendance=EXCLUDED.attendance
             RETURNING id`,
            [
              s.username.toLowerCase(),
              s.name,
              s.phone,
              s.email,
              s.parentname,
              s.parentphone,
              s.year,
              s.aadhaar,
              s.address,
              s.attendance || "0"
            ]
          );

          const studentId = student.rows[0].id;

          const exists = await pool.query(
            "SELECT id FROM users WHERE username=$1",
            [s.username.toLowerCase()]
          );

          if (!exists.rows.length) {
            const hashed = await bcrypt.hash("123456", 10);

            await pool.query(
              "INSERT INTO users(username,password,role,studentid) VALUES($1,$2,$3,$4)",
              [s.username.toLowerCase(), hashed, "student", studentId]
            );
          }

          count++;
        }

        res.json({
          message: `${count} students uploaded successfully`
        });

      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Upload failed" });
      }

      fs.unlinkSync(req.file.path);
    });
});

/* ---------- Login ---------- */
app.post("/login", async (req, res) => {
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
});

/* ---------- Get Student ---------- */
app.get("/student/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,
              username,
              name,
              phone,
              email,
              parentname,
              parentphone,
              year,
              aadhaar,
              address,
              attendance,
              marks
       FROM students
       WHERE id = $1`,
      [req.params.id]
    );

    if (!result.rows.length)
      return res.json(null);

    const student = result.rows[0];

    student.marks = student.marks
      ? JSON.parse(student.marks)
      : {};

    res.json(student);

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------- Update Marks ---------- */
app.post("/updateByUsername", async (req, res) => {
  const { username, attendance, subject, marks } = req.body;

  const user = await pool.query(
    "SELECT studentid FROM users WHERE username=$1",
    [username.trim().toLowerCase()]
  );

  if (!user.rows.length)
    return res.json({ message: "User not found" });

  const studentId = user.rows[0].studentid;

  const student = await pool.query(
    "SELECT marks FROM students WHERE id=$1",
    [studentId]
  );

  let marksObj = JSON.parse(student.rows[0].marks || "{}");

  if (subject && marks)
    marksObj[subject] = marks;

  await pool.query(
    "UPDATE students SET attendance=$1, marks=$2 WHERE id=$3",
    [attendance, JSON.stringify(marksObj), studentId]
  );

  res.json({ message: "Updated successfully" });
});

/* ---------- Delete ---------- */
app.delete("/deleteStudent/:id", async (req, res) => {
  const id = req.params.id;

  await pool.query("DELETE FROM students WHERE id=$1", [id]);
  await pool.query("DELETE FROM users WHERE studentid=$1", [id]);

  res.json({ message: "Deleted successfully" });
});

/* ---------- Server ---------- */
app.listen(5000, () =>
  console.log("🚀 Server running on port 5000")
);
