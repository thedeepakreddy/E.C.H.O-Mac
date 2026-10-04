"""Isolated benchmark fixture: local CRUD prototype, not production auth."""
import http.server, json, sqlite3, pathlib
root = pathlib.Path(__file__).parent
connection = sqlite3.connect(root / 'fixture.sqlite', check_same_thread=False)
connection.execute('create table if not exists items (id integer primary key, text text not null)')
class Server(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/items':
            rows = [{'id': row[0], 'text': row[1]} for row in connection.execute('select id,text from items')]
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(json.dumps(rows).encode())
        else: super().do_GET()
    def do_POST(self):
        try:
            data = json.loads(self.rfile.read(min(int(self.headers.get('Content-Length', '0')), 4096)))
            text = data['text']
            if not isinstance(text, str) or not text.strip() or len(text) > 100: raise ValueError()
            connection.execute('insert into items(text) values (?)', (text,)); connection.commit()
            self.send_response(201); self.end_headers()
        except (ValueError, KeyError): self.send_response(400); self.end_headers()
    def do_PUT(self):
        try:
            data = json.loads(self.rfile.read(min(int(self.headers.get('Content-Length', '0')), 4096)))
            if not isinstance(data['text'], str) or not data['text'].strip(): raise ValueError()
            connection.execute('update items set text=? where id=?', (data['text'], data['id'])); connection.commit()
            self.send_response(200); self.end_headers()
        except (ValueError, KeyError): self.send_response(400); self.end_headers()
server = http.server.HTTPServer(('127.0.0.1', 0), Server)
print(json.dumps({'echoPreviewReady': True, 'url': f'http://127.0.0.1:{server.server_port}'}, separators=(',', ':')), flush=True)
server.serve_forever()
