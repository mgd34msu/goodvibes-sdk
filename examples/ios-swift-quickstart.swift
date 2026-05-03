/*
 ios-swift-quickstart.swift — Minimal URLSession control-plane and WebSocket calls.

 Set GOODVIBES_TOKEN before running. Replace the base URL with your daemon or
 companion gateway endpoint.
 */
import Foundation

let baseUrl = URL(string: "https://goodvibes.example.com")!
let token = ProcessInfo.processInfo.environment["GOODVIBES_TOKEN"]!

var authRequest = URLRequest(url: baseUrl.appending(path: "/api/control-plane/auth"))
authRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

let semaphore = DispatchSemaphore(value: 0)
URLSession.shared.dataTask(with: authRequest) { data, _, error in
    if let error {
        print(error)
    } else if let data {
        print(String(decoding: data, as: UTF8.self))
    }
    semaphore.signal()
}.resume()
semaphore.wait()

let wsUrl = URL(string: "wss://goodvibes.example.com/api/control-plane/ws")!
let socket = URLSession.shared.webSocketTask(with: wsUrl)
socket.resume()

let authFrame: [String: Any] = [
    "type": "auth",
    "token": token,
    "domains": ["agents"]
]
let payload = try JSONSerialization.data(withJSONObject: authFrame)
socket.send(.data(payload)) { error in
    if let error {
        print(error)
    }
}

socket.receive { result in
    switch result {
    case .success(let message):
        print(message)
    case .failure(let error):
        print(error)
    }
}
