//! Integration tests for the JSON-RPC stdio server, driven over an in-memory
//! duplex pipe with the test acting as the IDE client.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use localpilot_core::protocol::methods;
use localpilot_core::rpc::{Ctx, Handler, Message, RpcError, RpcServer};
use serde_json::{Value, json};
use tokio::io::{
    AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, ReadHalf, WriteHalf,
};
use tokio::task::JoinHandle;
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(5);

struct TestHandler;

#[async_trait]
impl Handler for TestHandler {
    async fn request(&self, method: &str, params: Value, ctx: Ctx) -> Result<Value, RpcError> {
        match method {
            "echo" => Ok(params),
            "slow" => {
                tokio::time::sleep(Duration::from_millis(200)).await;
                Ok(json!("slow"))
            }
            "fast" => Ok(json!("fast")),
            "edit" => ctx.request(methods::APPLY_EDIT, params).await,
            _ => Err(RpcError::method_not_found(method)),
        }
    }

    async fn notify(&self, _method: &str, _params: Value, _ctx: Ctx) {}
}

struct Client {
    lines: Lines<BufReader<ReadHalf<DuplexStream>>>,
    writer: WriteHalf<DuplexStream>,
}

impl Client {
    async fn send_raw(&mut self, line: &str) {
        self.writer.write_all(line.as_bytes()).await.unwrap();
        self.writer.write_all(b"\n").await.unwrap();
        self.writer.flush().await.unwrap();
    }

    async fn send(&mut self, msg: Message) {
        self.send_raw(&msg.encode()).await;
    }

    async fn recv(&mut self) -> Message {
        let line = timeout(WAIT, self.lines.next_line())
            .await
            .expect("timed out waiting for server message")
            .unwrap()
            .expect("server closed the stream");
        Message::decode(&line).expect("server sent an invalid message")
    }
}

fn start() -> (Client, JoinHandle<anyhow::Result<()>>) {
    let (client_end, server_end) = tokio::io::duplex(64 * 1024);
    let (server_read, server_write) = tokio::io::split(server_end);
    let server = RpcServer::new(
        BufReader::new(server_read),
        server_write,
        Arc::new(TestHandler),
    );
    let task = tokio::spawn(server.run());
    let (client_read, client_write) = tokio::io::split(client_end);
    let client = Client {
        lines: BufReader::new(client_read).lines(),
        writer: client_write,
    };
    (client, task)
}

fn request(id: i64, method: &str, params: Value) -> Message {
    Message::Request {
        id: json!(id),
        method: method.to_string(),
        params,
    }
}

fn expect_response(msg: Message) -> (Value, Option<Value>, Option<RpcError>) {
    match msg {
        Message::Response { id, result, error } => (id, result, error),
        other => panic!("expected a response, got {other:?}"),
    }
}

#[tokio::test]
async fn request_gets_response_with_same_id() {
    let (mut client, _task) = start();
    client
        .send(request(7, "echo", json!({"hello": "world"})))
        .await;
    let (id, result, error) = expect_response(client.recv().await);
    assert_eq!(id, json!(7));
    assert_eq!(result, Some(json!({"hello": "world"})));
    assert!(error.is_none());

    // String ids are echoed back verbatim too.
    client
        .send_raw(r#"{"jsonrpc":"2.0","id":"abc","method":"echo","params":[1]}"#)
        .await;
    let (id, result, _) = expect_response(client.recv().await);
    assert_eq!(id, json!("abc"));
    assert_eq!(result, Some(json!([1])));
}

#[tokio::test]
async fn unknown_method_returns_32601() {
    let (mut client, _task) = start();
    client.send(request(1, "no/such", Value::Null)).await;
    let (id, result, error) = expect_response(client.recv().await);
    assert_eq!(id, json!(1));
    assert!(result.is_none());
    let error = error.expect("error expected");
    assert_eq!(error.code, -32601);
    assert_eq!(error.code, RpcError::METHOD_NOT_FOUND);
}

#[tokio::test]
async fn malformed_line_is_ignored_and_server_keeps_running() {
    let (mut client, task) = start();
    client.send_raw("this is not json").await;
    client
        .send_raw(r#"{"jsonrpc":"2.0","no":"method or id"}"#)
        .await;
    client.send_raw("").await;
    client.send(request(2, "echo", json!("still alive"))).await;
    let (id, result, _) = expect_response(client.recv().await);
    assert_eq!(id, json!(2));
    assert_eq!(result, Some(json!("still alive")));
    assert!(!task.is_finished());
}

#[tokio::test]
async fn server_can_send_request_to_client_and_await_response() {
    let (mut client, _task) = start();
    client
        .send(request(3, "edit", json!({"ops": [], "save": false})))
        .await;

    let (out_id, method, params) = match client.recv().await {
        Message::Request { id, method, params } => (id, method, params),
        other => panic!("expected a server->client request, got {other:?}"),
    };
    assert_eq!(method, methods::APPLY_EDIT);
    assert_eq!(params, json!({"ops": [], "save": false}));
    assert!(
        out_id.as_i64().expect("numeric id") < 0,
        "outgoing ids are negative"
    );

    client
        .send(Message::Response {
            id: out_id,
            result: Some(json!({"applied": true})),
            error: None,
        })
        .await;

    let (id, result, error) = expect_response(client.recv().await);
    assert_eq!(id, json!(3));
    assert_eq!(result, Some(json!({"applied": true})));
    assert!(error.is_none());
}

#[tokio::test]
async fn slow_request_does_not_block_fast_request() {
    let (mut client, _task) = start();
    client.send(request(1, "slow", Value::Null)).await;
    client.send(request(2, "fast", Value::Null)).await;
    let (first, _, _) = expect_response(client.recv().await);
    let (second, _, _) = expect_response(client.recv().await);
    assert_eq!(first, json!(2), "fast request must answer first");
    assert_eq!(second, json!(1));
}

#[tokio::test]
async fn eof_ends_run() {
    let (client, task) = start();
    drop(client);
    let outcome = timeout(WAIT, task)
        .await
        .expect("run did not return on EOF");
    outcome.unwrap().unwrap();
}
