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
app.use(express.static("../frontend"));

/* ---------- PostgreSQL ---------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

console.log("Connecting DB...");
pool.query("SELECT NOW()")
  .then(() => console.log("✅ PostgreSQL ready"))
  .catch(err => console.error(err));

/* ---------- DB Init ---------- */
async function initDB() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        name TEXT,
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
    .pipe(csv())
    .on("data", row => rows.push(row))
    .on("end", async () => {
      try {
        let count = 0;

        for (const s of rows) {
          if (!s.username || !s.name) continue;

          const username = s.username.trim().toLowerCase();
          const name = s.name.trim();

          const phone = s.phone || "";
          const email = s.email || "";
          const parentname = s.parentname || "";
          const parentphone = s.parentphone || "";
          const year = s.year || "";
          const aadhaar = s.aadhaar || "";
          const address = s.address || "";
          const attendance = s.attendance || "0%";

          // insert or update student
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
              username,
              name,
              phone,
              email,
              parentname,
              parentphone,
              year,
              aadhaar,
              address,
              attendance
            ]
          );

          const studentId = student.rows[0].id;

          // create login if not exists
          const exists = await pool.query(
            "SELECT id FROM users WHERE username=$1",
            [username]
          );

          if (!exists.rows.length) {
            const hashed = await bcrypt.hash("123456", 10);

            await pool.query(
              "INSERT INTO users(username,password,role,studentid) VALUES($1,$2,$3,$4)",
              [username, hashed, "student", studentId]
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

/* ---------- Register ---------- */
app.post("/register", async (req, res) => {
  const { name, username, password } = req.body;

  const uname = username.trim().toLowerCase();

  const exists = await pool.query(
    "SELECT id FROM users WHERE username=$1",
    [uname]
  );

  if (exists.rows.length > 0)
    return res.json({ success: false });

  const student = await pool.query(
    "INSERT INTO students(name,attendance,marks) VALUES($1,$2,$3) RETURNING id",
    [name, "0%", "{}"]
  );

  const hashed = await bcrypt.hash(password, 10);

  await pool.query(
    "INSERT INTO users(username,password,role,studentid) VALUES($1,$2,$3,$4)",
    [uname, hashed, "student", student.rows[0].id]
  );

  res.json({ success: true });
});

/* ---------- Students ---------- */
app.get("/students", async (req, res) => {
  const result = await pool.query("SELECT * FROM students");

  result.rows.forEach(r => {
    r.marks = JSON.parse(r.marks || "{}");
  });

  res.json(result.rows);
});

app.get("/student/:id", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM students WHERE id=$1",
    [req.params.id]
  );

  if (!result.rows.length)
    return res.json(null);

  const student = result.rows[0];
  student.marks = JSON.parse(student.marks || "{}");

  res.json(student);
});

/* ---------- Update ---------- */
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
