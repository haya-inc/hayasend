package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"slices"
	"time"

	"github.com/resend/resend-go/v3"
)

func requireLoopbackEndpoint(raw string) (*url.URL, error) {
	if raw == "" {
		return nil, errors.New("RESEND_BASE_URL must identify a loopback HayaSend endpoint")
	}
	endpoint, err := url.Parse(raw)
	if err != nil ||
		(endpoint.Scheme != "http" && endpoint.Scheme != "https") ||
		endpoint.Host == "" ||
		endpoint.User != nil ||
		endpoint.RawQuery != "" ||
		endpoint.Fragment != "" {
		return nil, errors.New("RESEND_BASE_URL must be an absolute loopback HTTP endpoint")
	}
	host := endpoint.Hostname()
	address := net.ParseIP(host)
	if host != "localhost" && (address == nil || !address.IsLoopback()) {
		return nil, errors.New("RESEND_BASE_URL must use a loopback host")
	}
	return endpoint, nil
}

func require(condition bool, message string) {
	if !condition {
		panic(message)
	}
}

func main() {
	endpoint, err := requireLoopbackEndpoint(os.Getenv("RESEND_BASE_URL"))
	if err != nil {
		panic(err)
	}
	apiKey := os.Getenv("RESEND_API_KEY")
	require(apiKey != "", "RESEND_API_KEY is required")

	client := resend.NewClient(apiKey)
	require(
		client.BaseURL.Scheme == endpoint.Scheme &&
			client.BaseURL.Host == endpoint.Host,
		"the official SDK did not use RESEND_BASE_URL",
	)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	single := &resend.SendEmailRequest{
		From:    "Go SDK <sender@example.com>",
		To:      []string{"recipient@example.net"},
		Subject: "HayaSend Go SDK compatibility",
		Text:    "Sent through the official Resend Go SDK.",
	}
	sendOptions := &resend.SendEmailOptions{
		IdempotencyKey: "go-sdk-single",
	}
	first, err := client.Emails.SendWithOptions(ctx, single, sendOptions)
	require(err == nil, fmt.Sprintf("single send failed: %v", err))
	require(first.Id != "", "single send returned an empty ID")

	replayed, err := client.Emails.SendWithOptions(ctx, single, sendOptions)
	require(err == nil, fmt.Sprintf("single replay failed: %v", err))
	require(replayed.Id == first.Id, "single replay returned a different ID")

	retrieved, err := client.Emails.GetWithContext(ctx, first.Id)
	require(err == nil, fmt.Sprintf("retrieve failed: %v", err))
	require(
		retrieved.Id == first.Id &&
			retrieved.Subject == single.Subject &&
			slices.Equal(retrieved.To, single.To),
		"retrieved email did not match the send",
	)

	listed, err := client.Emails.ListWithContext(ctx)
	require(err == nil, fmt.Sprintf("list failed: %v", err))
	require(
		slices.ContainsFunc(listed.Data, func(email resend.Email) bool {
			return email.Id == first.Id
		}),
		"list did not contain the sent email",
	)

	batchRequest := []*resend.SendEmailRequest{
		{
			From:    single.From,
			To:      []string{"first@example.net"},
			Subject: "HayaSend Go SDK batch one",
			Text:    single.Text,
		},
		{
			From:    single.From,
			To:      []string{"second@example.net"},
			Subject: "HayaSend Go SDK batch two",
			Text:    single.Text,
		},
	}
	batchOptions := &resend.BatchSendEmailOptions{
		IdempotencyKey:  "go-sdk-batch",
		BatchValidation: resend.BatchValidationStrict,
	}
	batch, err := client.Batch.SendWithOptions(ctx, batchRequest, batchOptions)
	require(err == nil, fmt.Sprintf("batch send failed: %v", err))
	require(len(batch.Data) == len(batchRequest), "batch returned the wrong number of IDs")

	batchReplay, err := client.Batch.SendWithOptions(
		ctx,
		batchRequest,
		batchOptions,
	)
	require(err == nil, fmt.Sprintf("batch replay failed: %v", err))
	require(
		len(batchReplay.Data) == len(batch.Data),
		"batch replay returned the wrong number of IDs",
	)
	for index := range batch.Data {
		require(
			batchReplay.Data[index].Id == batch.Data[index].Id,
			"batch replay returned a different ID",
		)
	}

	err = json.NewEncoder(os.Stdout).Encode(map[string]any{
		"sdk":             "resend-go",
		"version":         "3.11.0",
		"send":            "passed",
		"idempotency":     "passed",
		"get":             "passed",
		"list":            "passed",
		"batch":           "passed",
		"created_records": 3,
	})
	require(err == nil, fmt.Sprintf("result encoding failed: %v", err))
}
