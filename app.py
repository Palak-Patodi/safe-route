from flask import Flask, request, jsonify, session
from flask_cors import CORS
import MySQLdb
import requests
import os

app = Flask(__name__)
CORS(app)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "your_secret_key")

# Database Connection
DB_HOST = "your_mysql_host"
DB_USER = "your_mysql_user"
DB_PASSWORD = "your_mysql_password"
DB_NAME = "your_database_name"

def get_db_connection():
    return MySQLdb.connect(host=DB_HOST, user=DB_USER, passwd=DB_PASSWORD, db=DB_NAME, cursorclass=MySQLdb.cursors.DictCursor)

# Google Sign-Up Route
@app.route('/google-signup', methods=['POST'])
def google_signup():
    token = request.json.get("token")
    if not token:
        return jsonify({"error": "Token is required"}), 400
    
    # Verify the token with Google
    google_verify_url = f"https://oauth2.googleapis.com/tokeninfo?id_token={token}"
    response = requests.get(google_verify_url)
    user_data = response.json()
    
    if "email" not in user_data:
        return jsonify({"error": "Invalid token"}), 400
    
    google_id = user_data.get("sub")
    name = user_data.get("name")
    email = user_data.get("email")
    
    # Store user in MySQL if not exists
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE google_id = %s", (google_id,))
    existing_user = cursor.fetchone()
    
    if not existing_user:
        cursor.execute("INSERT INTO users (google_id, name, email) VALUES (%s, %s, %s)", (google_id, name, email))
        conn.commit()
    
    cursor.close()
    conn.close()
    session["user"] = {"name": name, "email": email}
    return jsonify({"success": True, "name": name, "email": email})

if __name__ == '__main__':
    app.run(debug=True)
