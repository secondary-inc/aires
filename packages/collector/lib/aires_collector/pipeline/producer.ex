defmodule AiresCollector.Pipeline.Producer do
  @moduledoc """
  Broadway producer that receives events via push from the gRPC server.
  Events are pushed into an internal queue and drained by Broadway.
  """
  use GenStage

  def start_link(opts) do
    GenStage.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def push(events) when is_list(events) do
    GenStage.cast(__MODULE__, {:push, events})
  end

  @impl true
  def init(_opts) do
    {:producer, %{queue: :queue.new(), demand: 0}}
  end

  @impl true
  def handle_cast({:push, events}, %{queue: queue, demand: demand} = state) do
    queue = Enum.reduce(events, queue, fn event, q -> :queue.in(event, q) end)
    {events_to_send, new_queue, new_demand} = take_from_queue(queue, demand)

    {:noreply, events_to_send, %{state | queue: new_queue, demand: new_demand}}
  end

  @impl true
  def handle_demand(incoming_demand, %{queue: queue, demand: demand} = state) do
    total_demand = demand + incoming_demand
    {events_to_send, new_queue, new_demand} = take_from_queue(queue, total_demand)

    {:noreply, events_to_send, %{state | queue: new_queue, demand: new_demand}}
  end

  defp take_from_queue(queue, demand) do
    take_from_queue(queue, demand, [])
  end

  defp take_from_queue(queue, 0, acc) do
    {Enum.reverse(acc), queue, 0}
  end

  defp take_from_queue(queue, demand, acc) do
    case :queue.out(queue) do
      {{:value, event}, new_queue} ->
        take_from_queue(new_queue, demand - 1, [event | acc])

      {:empty, queue} ->
        {Enum.reverse(acc), queue, demand}
    end
  end
end
