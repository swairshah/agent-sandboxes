// Package rpc is the line-delimited JSON protocol between the pi extension and
// sbx. Each request carries an id; the reply repeats it. Streaming requests
// (exec) send {"id","ev":"data"} messages before their final reply.
package rpc

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
)

// Request is one call. Params stay raw so handlers decode their own shape.
type Request struct {
	ID     int64           `json:"id"`
	Op     string          `json:"op"`
	Params json.RawMessage `json:"-"`
}

// Conn reads requests and writes replies. Writes are serialized.
type Conn struct {
	r  *bufio.Reader
	mu sync.Mutex
	w  io.Writer
}

func NewConn(r io.Reader, w io.Writer) *Conn {
	return &Conn{r: bufio.NewReaderSize(r, 1<<20), w: w}
}

// Read returns the next request, or io.EOF when the peer hangs up.
func (c *Conn) Read() (*Request, []byte, error) {
	line, err := c.r.ReadBytes('\n')
	if err != nil {
		if len(line) == 0 {
			return nil, nil, err
		}
	}
	var req Request
	if err := json.Unmarshal(line, &req); err != nil {
		return nil, line, err
	}
	req.Params = line
	return &req, line, nil
}

// Send writes one message.
func (c *Conn) Send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err = c.w.Write(b)
	return err
}

// SendRaw writes an already encoded message line.
func (c *Conn) SendRaw(line []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(line) == 0 || line[len(line)-1] != '\n' {
		line = append(line, '\n')
	}
	_, err := c.w.Write(line)
	return err
}

// Reply sends a successful result. result is merged into the reply object.
func (c *Conn) Reply(id int64, result map[string]any) error {
	if result == nil {
		result = map[string]any{}
	}
	result["id"] = id
	result["ok"] = true
	return c.Send(result)
}

func (c *Conn) Error(id int64, err error) error {
	return c.Send(map[string]any{"id": id, "error": err.Error()})
}

// Data streams a chunk of output for request id.
func (c *Conn) Data(id int64, b []byte) error {
	return c.Send(map[string]any{"id": id, "ev": "data", "d": b}) // []byte encodes as base64
}
